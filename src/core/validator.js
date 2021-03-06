import ErrorBag from './errorBag';
import { isObject, isCallable, toArray, createError, assign, find, isNullOrUndefined, includes } from './utils';
import FieldBag from './fieldBag';
import Field from './field';
import Config from '../config';

// @flow

const RULES: { [string]: Rule } = {};
let STRICT_MODE: boolean = true;

export default class Validator {
  strict: boolean;
  errors: ErrorBag;
  fields: FieldBag;
  flags: MapObject;
  fastExit: boolean;
  paused: boolean;
  reset: (matcher) => Promise<void>;

  constructor (validations?: MapObject, options?: MapObject = { fastExit: true }) {
    this.strict = STRICT_MODE;
    this.errors = new ErrorBag();
    this.fields = new FieldBag();
    this._createFields(validations);
    this.paused = false;
    this.fastExit = !isNullOrUndefined(options && options.fastExit) ? options.fastExit : true;
  }

  static get rules () {
    return RULES;
  }

  get rules () {
    return RULES;
  }

  get flags () {
    return this.fields.items.reduce((acc, field) => {
      if (field.scope) {
        acc[`$${field.scope}`] = {
          [field.name]: field.flags
        };

        return acc;
      }

      acc[field.name] = field.flags;

      return acc;
    }, {});
  }

  /**
   * Getter for the dictionary.
   */
  get dictionary (): IDictionary {
    return Config.dependency('dictionary');
  }

  static get dictionary () {
    return Config.dependency('dictionary');
  }

  get _vm () {
    return Config.dependency('vm');
  }

  /**
   * Getter for the current locale.
   */
  get locale (): string {
    return Validator.locale;
  }

  /**
   * Setter for the validator locale.
   */
  set locale (value: string): void {
    Validator.locale = value;
  }

  static get locale () {
    return this.dictionary.locale;
  }

  /**
   * Setter for the validator locale.
   */
  static set locale (value) {
    const hasChanged = value !== Validator.dictionary.locale;
    Validator.dictionary.locale = value;
    if (hasChanged && Config.dependency('vm')) {
      Config.dependency('vm').$emit('localeChanged');
    }
  }

  /**
   * Static constructor.
   */
  static create (validations?: MapObject, options?: MapObject): Validator {
    return new Validator(validations, options);
  }

  /**
   * Adds a custom validator to the list of validation rules.
   */
  static extend (name: string, validator: Rule | Object, options?: ExtendOptions = {}) {
    Validator._guardExtend(name, validator);
    Validator._merge(name, {
      validator,
      options: assign({}, { hasTarget: false, immediate: true }, options || {})
    });
  }

  /**
   * Removes a rule from the list of validators.
   */
  static remove (name: string): void {
    delete RULES[name];
  }

  /**
   * Checks if the given rule name is a rule that targets other fields.
   */
  static isTargetRule (name: string): boolean {
    return !!RULES[name] && RULES[name].options.hasTarget;
  }

  /**
   * Sets the operating mode for all newly created validators.
   * strictMode = true: Values without a rule are invalid and cause failure.
   * strictMode = false: Values without a rule are valid and are skipped.
   */
  static setStrictMode (strictMode?: boolean = true) {
    STRICT_MODE = strictMode;
  }

  /**
   * Adds and sets the current locale for the validator.
   */
  localize (lang: string, dictionary?: MapObject): void {
    Validator.localize(lang, dictionary);
  }

  /**
   * Adds and sets the current locale for the validator.
   */
  static localize (lang: string | MapObject, dictionary?: MapObject) {
    if (isObject(lang)) {
      Validator.dictionary.merge(lang);
      return;
    }

    // merge the dictionary.
    if (dictionary) {
      const locale = lang || dictionary.name;
      dictionary = assign({}, dictionary);
      Validator.dictionary.merge({
        [locale]: dictionary
      });
    }

    if (lang) {
      // set the locale.
      Validator.locale = lang;
    }
  }

  /**
   * Registers a field to be validated.
   */
  attach (fieldOpts: FieldOptions): Field {
    // fixes initial value detection with v-model and select elements.
    const value = fieldOpts.initialValue;
    const field = new Field(fieldOpts);
    this.fields.push(field);

    // validate the field initially
    if (field.immediate) {
      this.validate(`#${field.id}`, value || field.value);
    } else {
      this._validate(field, value || field.value, { initial: true }).then(result => {
        field.flags.valid = result.valid;
        field.flags.invalid = !result.valid;
      });
    }

    return field;
  }

  /**
   * Sets the flags on a field.
   */
  flag (name: string, flags: { [string]: boolean }, uid = null) {
    const field = this._resolveField(name, undefined, uid);
    if (!field || !flags) {
      return;
    }

    field.setFlags(flags);
  }

  /**
   * Removes a field from the validator.
   */
  detach (name: string, scope?: string | null, uid) {
    let field = isCallable(name.destroy) ? name : this._resolveField(name, scope, uid);
    if (!field) return;

    field.destroy();
    this.errors.remove(field.name, field.scope, field.id);
    this.fields.remove(field);
  }

  /**
   * Adds a custom validator to the list of validation rules.
   */
  extend (name: string, validator: Rule | MapObject, options?: ExtendOptions = {}) {
    Validator.extend(name, validator, options);
  }

  reset (matcher) {
    // two ticks
    return this._vm.$nextTick().then(() => {
      return this._vm.$nextTick();
    }).then(() => {
      this.fields.filter(matcher).forEach(field => {
        field.reset(); // reset field flags.
        this.errors.remove(field.name, field.scope, field.id);
      });
    });
  }

  /**
   * Updates a field, updating both errors and flags.
   */
  update (id: string, { scope }) {
    const field = this._resolveField(`#${id}`);
    if (!field) return;

    // remove old scope.
    this.errors.update(id, { scope });
  }

  /**
   * Removes a rule from the list of validators.
   */
  remove (name: string) {
    Validator.remove(name);
  }

  /**
   * Validates a value against a registered field validations.
   */
  validate (fieldDescriptor: string, value?: any, { silent, vmId } = {}): Promise<boolean> {
    if (this.paused) return Promise.resolve(true);

    // overload to validate all.
    if (isNullOrUndefined(fieldDescriptor)) {
      return this.validateScopes({ silent, vmId });
    }

    // overload to validate scope-less fields.
    if (fieldDescriptor === '*') {
      return this.validateAll(undefined, { silent, vmId });
    }

    // if scope validation was requested.
    if (/^(.+)\.\*$/.test(fieldDescriptor)) {
      const matched = fieldDescriptor.match(/^(.+)\.\*$/)[1];
      return this.validateAll(matched);
    }

    const field = this._resolveField(fieldDescriptor);
    if (!field) {
      return this._handleFieldNotFound(name);
    }

    if (!silent) field.flags.pending = true;
    if (value === undefined) {
      value = field.value;
    }

    return this._validate(field, value).then(result => {
      if (!silent) {
        this._handleValidationResults([result]);
      }

      return result.valid;
    });
  }

  /**
   * Pauses the validator.
   */
  pause (): Validator {
    this.paused = true;

    return this;
  }

  /**
   * Resumes the validator.
   */
  resume (): Validator {
    this.paused = false;

    return this;
  }

  /**
   * Validates each value against the corresponding field validations.
   */
  validateAll (values?: string | MapObject, { silent, vmId } = {}): Promise<boolean> {
    if (this.paused) return Promise.resolve(true);

    let matcher = null;
    let providedValues = false;

    if (typeof values === 'string') {
      matcher = { scope: values, vmId };
    } else if (isObject(values)) {
      matcher = Object.keys(values).map(key => {
        return { name: key, vmId: vmId, scope: null };
      });
      providedValues = true;
    } else if (Array.isArray(values)) {
      matcher = values.map(key => {
        return { name: key, vmId: vmId };
      });
    } else {
      matcher = { scope: null, vmId: vmId };
    }

    return Promise.all(
      this.fields.filter(matcher).map(field => this._validate(field, providedValues ? values[field.name] : field.value))
    ).then(results => {
      if (!silent) {
        this._handleValidationResults(results);
      }

      return results.every(t => t.valid);
    });
  }

  /**
   * Validates all scopes.
   */
  validateScopes ({ silent, vmId } = {}): Promise<boolean> {
    if (this.paused) return Promise.resolve(true);

    return Promise.all(
      this.fields.filter({ vmId }).map(field => this._validate(field, field.value))
    ).then(results => {
      if (!silent) {
        this._handleValidationResults(results);
      }

      return results.every(t => t.valid);
    });
  }

  /**
   * Perform cleanup.
   */
  destroy () {
    this._vm.$off('localeChanged');
  }

  /**
   * Creates the fields to be validated.
   */
  _createFields (validations?: MapObject) {
    if (!validations) return;

    Object.keys(validations).forEach(field => {
      const options = assign({}, { name: field, rules: validations[field] });
      this.attach(options);
    });
  }

  /**
   * Date rules need the existence of a format, so date_format must be supplied.
   */
  _getDateFormat (validations: Array<MapObject>): ?string {
    let format = null;
    if (validations.date_format && Array.isArray(validations.date_format)) {
      format = validations.date_format[0];
    }

    return format || this.dictionary.getDateFormat(this.locale);
  }

  /**
   * Formats an error message for field and a rule.
   */
  _formatErrorMessage (field: Field, rule: MapObject, data?: MapObject = {}, targetName?: string | null = null) {
    const name = this._getFieldDisplayName(field);
    const params = this._getLocalizedParams(rule, targetName);

    return this.dictionary.getFieldMessage(this.locale, field.name, rule.name, [name, params, data]);
  }

  /**
   * Translates the parameters passed to the rule (mainly for target fields).
   */
  _getLocalizedParams (rule: MapObject, targetName?: string | null = null) {
    if (rule.options.hasTarget && rule.params && rule.params[0]) {
      const localizedName = targetName || this.dictionary.getAttribute(this.locale, rule.params[0], rule.params[0]);
      return [localizedName].concat(rule.params.slice(1));
    }

    return rule.params;
  }

  /**
   * Resolves an appropriate display name, first checking 'data-as' or the registered 'prettyName'
   */
  _getFieldDisplayName (field: Field) {
    return field.alias || this.dictionary.getAttribute(this.locale, field.name, field.name);
  }

  /**
   * Tests a single input value against a rule.
   */
  _test (field: Field, value: any, rule: MapObject): ValidationResult | Promise<ValidationResult> {
    const validator = RULES[rule.name] ? RULES[rule.name].validate : null;
    let params = Array.isArray(rule.params) ? toArray(rule.params) : [];
    let targetName = null;
    if (!validator || typeof validator !== 'function') {
      return Promise.reject(createError(`No such validator '${rule.name}' exists.`));
    }

    // has field dependencies.
    if (rule.options.hasTarget) {
      const target = find(field.dependencies, d => d.name === rule.name);
      if (target) {
        targetName = target.field.alias;
        params = [target.field.value].concat(params.slice(1));
      }
    } else if (rule.name === 'required' && field.rejectsFalse) {
      // invalidate false if no args were specified and the field rejects false by default.
      params = params.length ? params : [true];
    }

    if (rule.options.isDate) {
      const dateFormat = this._getDateFormat(field.rules);
      if (rule.name !== 'date_format') {
        params.push(dateFormat);
      }
    }

    let result = validator(value, params);

    // If it is a promise.
    if (isCallable(result.then)) {
      return result.then(values => {
        let allValid = true;
        let data = {};
        if (Array.isArray(values)) {
          allValid = values.every(t => (isObject(t) ? t.valid : t));
        } else { // Is a single object/boolean.
          allValid = isObject(values) ? values.valid : values;
          data = values.data;
        }

        return {
          valid: allValid,
          errors: allValid ? [] : [this._createFieldError(field, rule, data, targetName)]
        };
      });
    }

    if (!isObject(result)) {
      result = { valid: result, data: {} };
    }

    return {
      valid: result.valid,
      errors: result.valid ? [] : [this._createFieldError(field, rule, result.data, targetName)]
    };
  }

  /**
   * Merges a validator object into the RULES and Messages.
   */
  static _merge (name: string, { validator, options }) {
    const validate = isCallable(validator) ? validator : validator.validate;
    if (validator.getMessage) {
      Validator.dictionary.setMessage(Validator.locale, name, validator.getMessage);
    }

    RULES[name] = {
      validate,
      options
    };
  }

  /**
   * Guards from extension violations.
   */
  static _guardExtend (name: string, validator: Rule) {
    if (isCallable(validator)) {
      return;
    }

    if (!isCallable(validator.validate)) {
      throw createError(
        `Extension Error: The validator '${name}' must be a function or have a 'validate' method.`
      );
    }
  }

  /**
   * Creates a Field Error Object.
   */
  _createFieldError (field: Field, rule: MapObject, data: MapObject, targetName?: string): FieldError {
    return {
      id: field.id,
      vmId: field.vmId,
      field: field.name,
      msg: this._formatErrorMessage(field, rule, data, targetName),
      rule: rule.name,
      scope: field.scope,
      regenerate: () => {
        return this._formatErrorMessage(field, rule, data, targetName);
      }
    };
  }

  /**
   * Tries different strategies to find a field.
   */
  _resolveField (name: string, scope: string | null, uid): ?Field {
    if (name[0] === '#') {
      return this.fields.find({ id: name.slice(1) });
    }

    if (!isNullOrUndefined(scope)) {
      return this.fields.find({ name, scope, vmId: uid });
    }

    if (includes(name, '.')) {
      const [fieldScope, ...fieldName] = name.split('.');
      const field = this.fields.find({ name: fieldName.join('.'), scope: fieldScope, vmId: uid });
      if (field) {
        return field;
      }
    }

    return this.fields.find({ name, scope: null, vmId: uid });
  }

  /**
   * Handles when a field is not found depending on the strict flag.
   */
  _handleFieldNotFound (name: string, scope?: string | null) {
    if (!this.strict) return Promise.resolve(true);

    const fullName = isNullOrUndefined(scope) ? name : `${!isNullOrUndefined(scope) ? scope + '.' : ''}${name}`;

    return Promise.reject(createError(
      `Validating a non-existent field: "${fullName}". Use "attach()" first.`
    ));
  }

  /**
   * Handles validation results.
   */
  _handleValidationResults (results) {
    const matchers = results.map(result => ({ id: result.id }));
    this.errors.removeById(matchers.map(m => m.id));
    // remove by name and scope to remove any custom errors added.
    results.forEach(result => {
      this.errors.remove(result.field, result.scope);
    });
    const allErrors = results.reduce((prev, curr) => {
      prev.push(...curr.errors);

      return prev;
    }, []);

    this.errors.add(allErrors);

    // handle flags.
    this.fields.filter(matchers).forEach(field => {
      const result = find(results, r => r.id === field.id);
      field.setFlags({
        pending: false,
        valid: result.valid,
        validated: true
      });
    });
  }

  _shouldSkip (field, value) {
    // field is configured to run through the pipeline regardless
    if (field.bails === false) {
      return false;
    }

    // disabled fields are skipped
    if (field.isDisabled) {
      return true;
    }

    // skip if the field is not required and has an empty value.
    return !field.isRequired && (isNullOrUndefined(value) || value === '');
  }

  _shouldBail (field, value) {
    // if the field was configured explicitly.
    if (field.bails !== undefined) {
      return field.bails;
    }

    return this.fastExit;
  }

  /**
   * Starts the validation process.
   */
  _validate (field: Field, value: any, { initial } = {}): Promise<ValidationResult> {
    if (this._shouldSkip(field, value)) {
      return Promise.resolve({ valid: true, id: field.id, field: field.name, scope: field.scope, errors: [] });
    }

    const promises = [];
    const errors = [];
    let isExitEarly = false;
    // use of '.some()' is to break iteration in middle by returning true
    Object.keys(field.rules).filter(rule => {
      if (!initial || !RULES[rule]) return true;

      return RULES[rule].options.immediate;
    }).some(rule => {
      const ruleOptions = RULES[rule] ? RULES[rule].options : {};
      const result = this._test(field, value, { name: rule, params: field.rules[rule], options: ruleOptions });
      if (isCallable(result.then)) {
        promises.push(result);
      } else if (!result.valid && this._shouldBail(field, value)) {
        errors.push(...result.errors);
        isExitEarly = true;
      } else {
        // promisify the result.
        promises.push(new Promise(resolve => resolve(result)));
      }

      return isExitEarly;
    });

    if (isExitEarly) {
      return Promise.resolve({ valid: false, errors, id: field.id, field: field.name, scope: field.scope });
    }

    return Promise.all(promises).then(results => {
      return results.reduce((prev, v) => {
        if (!v.valid) {
          prev.errors.push(...v.errors);
        }

        prev.valid = prev.valid && v.valid;

        return prev;
      }, { valid: true, errors, id: field.id, field: field.name, scope: field.scope });
    });
  }
}
