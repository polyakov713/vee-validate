import { find, isNullOrUndefined, isCallable, warn } from './utils';

// @flow

export default class ErrorBag {
  items: FieldError[];

  constructor () {
    this.items = [];
  }

  [typeof Symbol === 'function' ? Symbol.iterator : '@@iterator'] () {
    let index = 0;
    return {
      next: () => {
        return { value: this.items[index++], done: index > this.items.length };
      }
    };
  }

  /**
   * Adds an error to the internal array.
   */
  add (error: FieldError | FieldError[]) {
    // handle old signature.
    if (arguments.length > 1) {
      warn('This usage of "errors.add()" is deprecated, please consult the docs for the new signature.');
      error = {
        field: arguments[0],
        msg: arguments[1],
        rule: arguments[2],
        scope: !isNullOrUndefined(arguments[3]) ? arguments[3] : null,
        regenerate: null
      };
    }

    this.items.push(
      ...this._normalizeError(error)
    );
  }

  /**
   * Normalizes passed errors to an error array.
   */
  _normalizeError (error: FieldError | FieldError[]): FieldError[] {
    if (Array.isArray(error)) {
      return error.map(e => {
        e.scope = !isNullOrUndefined(e.scope) ? e.scope : null;

        return e;
      });
    }

    error.scope = !isNullOrUndefined(error.scope) ? error.scope : null;

    return [error];
  }

  /**
   * Regenrates error messages if they have a generator function.
   */
  regenerate (): void {
    this.items.forEach(i => {
      i.msg = isCallable(i.regenerate) ? i.regenerate() : i.msg;
    });
  }

  /**
   * Updates a field error with the new field scope.
   */
  update (id: string, error: FieldError) {
    const item = find(this.items, i => i.id === id);
    if (!item) {
      return;
    }

    const idx = this.items.indexOf(item);
    this.items.splice(idx, 1);
    item.scope = error.scope;
    this.items.push(item);
  }

  /**
   * Gets all error messages from the internal array.
   */
  all (scope: string): Array<string> {
    if (isNullOrUndefined(scope)) {
      return this.items.map(e => e.msg);
    }

    return this.items.filter(e => e.scope === scope).map(e => e.msg);
  }

  /**
   * Checks if there are any errors in the internal array.
   */
  any (scope: ?string): boolean {
    if (isNullOrUndefined(scope)) {
      return !!this.items.length;
    }

    return !!this.items.filter(e => e.scope === scope).length;
  }

  /**
   * Removes all items from the internal array.
   */
  clear (scope?: ?string) {
    if (isNullOrUndefined(scope)) {
      scope = null;
    }

    for (let i = 0; i < this.items.length; ++i) {
      if (this.items[i].scope === scope) {
        this.items.splice(i, 1);
        --i;
      }
    }
  }

  /**
   * Collects errors into groups or for a specific field.
   */
  collect (field?: string, scope?: string | null, map?: boolean = true) {
    if (!field) {
      const collection = {};
      this.items.forEach(e => {
        if (! collection[e.field]) {
          collection[e.field] = [];
        }

        collection[e.field].push(map ? e.msg : e);
      });

      return collection;
    }

    if (isNullOrUndefined(field)) {
      return [];
    }

    const selector = isNullOrUndefined(scope) ? String(field) : `${scope}.${field}`;
    const { isPrimary } = this._makeCandidateFilters(selector);

    return this.items.reduce((prev, curr) => {
      if (isPrimary(curr)) {
        prev.push(map ? curr.msg : curr);
      }

      return prev;
    }, []);
  }

  /**
   * Gets the internal array length.
   */
  count (): number {
    return this.items.length;
  }

  /**
   * Finds and fetches the first error message for the specified field id.
   */
  firstById (id: string): string | null {
    const error = find(this.items, i => i.id === id);

    return error ? error.msg : undefined;
  }

  /**
   * Gets the first error message for a specific field.
   */
  first (field: string, scope ?: ?string = null) {
    const selector = isNullOrUndefined(scope) ? field : `${scope}.${field}`;
    const match = this._match(selector);

    return match && match.msg;
  }

  /**
   * Returns the first error rule for the specified field
   */
  firstRule (field: string, scope ?: string): string | null {
    const errors = this.collect(field, scope, false);

    return (errors.length && errors[0].rule) || undefined;
  }

  /**
   * Checks if the internal array has at least one error for the specified field.
   */
  has (field: string, scope?: ?string = null): boolean {
    return !!this.first(field, scope);
  }

  /**
   * Gets the first error message for a specific field and a rule.
   */
  firstByRule (name: string, rule: string, scope?: string | null = null) {
    const error = this.collect(name, scope, false).filter(e => e.rule === rule)[0];

    return (error && error.msg) || undefined;
  }

  /**
   * Gets the first error message for a specific field that not match the rule.
   */
  firstNot (name: string, rule?: string = 'required', scope?: string | null = null) {
    const error = this.collect(name, scope, false).filter(e => e.rule !== rule)[0];

    return (error && error.msg) || undefined;
  }

  /**
   * Removes errors by matching against the id or ids.
   */
  removeById (id: string | string[]) {
    if (Array.isArray(id)) {
      // filter out the non-matching fields.
      this.items = this.items.filter(i => id.indexOf(i.id) === -1);
      return;
    }

    for (let i = 0; i < this.items.length; ++i) {
      if (this.items[i].id === id) {
        this.items.splice(i, 1);
        --i;
      }
    }
  }

  /**
   * Removes all error messages associated with a specific field.
   */
  remove (field: string, scope: ?string) {
    if (isNullOrUndefined(field)) {
      return;
    }

    const selector = isNullOrUndefined(scope) ? String(field) : `${scope}.${field}`;
    const { isPrimary } = this._makeCandidateFilters(selector);

    for (let i = 0; i < this.items.length; ++i) {
      if (isPrimary(this.items[i])) {
        this.items.splice(i, 1);
        --i;
      }
    }
  }

  _makeCandidateFilters (selector) {
    let matchesRule = () => true;
    let matchesScope = () => true;
    let matchesName = () => true;

    let [, scope, name, rule] = selector.match(/((?:[\w-])+\.)?((?:[\w-.])+)(:\w+)?/);
    if (rule) {
      rule = rule.replace(':', '');
      matchesRule = (item) => item.rule === rule;
    }

    // match by id, can be combined with rule selection.
    if (selector.startsWith('#')) {
      return item => matchesRule(item) && (item => selector.slice(1).startsWith(item.id));
    }

    if (isNullOrUndefined(scope)) {
      // if no scope specified, make sure the found error has no scope.
      matchesScope = item => isNullOrUndefined(item.scope);
    } else {
      scope = scope.replace('.', '');
      matchesScope = item => item.scope === scope;
    }

    if (!(isNullOrUndefined(name))) {
      matchesName = item => item.field === name;
    }

    // matches the first candidate.
    const isPrimary = (item) => {
      return matchesName(item) && matchesRule(item) && matchesScope(item);
    };

    // matches a second candidate, which is a field with a name containing the '.' character.
    const isAlt = (item) => {
      return matchesRule(item) && item.field === `${scope}.${name}`;
    };

    return {
      isPrimary,
      isAlt
    };
  }

  _match (selector: string) {
    if (isNullOrUndefined(selector)) {
      return undefined;
    }

    const { isPrimary, isAlt } = this._makeCandidateFilters(selector);

    return this.items.reduce((prev, item, idx, arr) => {
      const isLast = idx === arr.length - 1;
      if (prev.primary) {
        return isLast ? prev.primary : prev;
      }

      if (isPrimary(item)) {
        prev.primary = item;
      }

      if (isAlt(item)) {
        prev.alt = item;
      }

      // keep going.
      if (!isLast) {
        return prev;
      }

      return prev.primary || prev.alt;
    }, {});
  };
}
