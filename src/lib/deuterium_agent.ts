interface ListenerInfo {
  useCapture: boolean;
  listener: EventListenerOrEventListenerObject;
}

interface EventTarget {
  $$listeners?: {[type: string]: ListenerInfo[]};
}

/**
 * Agent injected into the webpage to surface browser-hidden leaks at the JS level.
 */
(function() {
  const addEventListener = EventTarget.prototype.addEventListener;
  const removeEventListener = EventTarget.prototype.removeEventListener;
  const r = /'/g;
  /**
   * Escapes single quotes in the given string.
   * @param s
   */
  function safeString(s: string): string {
    return s.replace(r, "\'");
  }

  /**
   * Creates a scope object.
   * @param parentScopeObject The scope object for the enclosing scope.
   * @param movedVariables Scope variables that have been "moved" to this object.
   * @param unmovedVariables Unmoved scope variables that are referenced from this object. Must be specified as getters/setters as this context does not have access to the unmoved variables.
   * @param args The name of the function's arguments.
   * @param argValues The values of the function's arguments.
   */
  function $$CREATE_SCOPE_OBJECT$$(parentScopeObject: Scope, movedVariables: string[], unmovedVariables: PropertyDescriptorMap, args: string[], argValues: any[]): Scope {
    const propMap: PropertyDescriptorMap = Object.assign(unmovedVariables, {
      "1map": {
        value: null,
        enumerable: true
      },
      "1parent": {
        value: parentScopeObject,
        enumerable: true
      },
      "1INTERCEPT_VAR_ASSIGNMENT": {
        value: function(this: Scope, name: string, map: Map<string | symbol | number, Set<string>>): boolean {
          if (!this.hasOwnProperty("0" + name)) {
            // Forward to parent scope.
            if (parentScopeObject["1INTERCEPT_VAR_ASSIGNMENT"]) {
              return parentScopeObject["1INTERCEPT_VAR_ASSIGNMENT"](name, map);
            } else {
              return false;
            }
          } else {
            if (!this["1map"]) {
              this["1map"] = new Map<string, Map<string | number | symbol, Set<string>>>();
            }
            this["1map"].set(name, map);
          }
          return true;
        },
        enumerable: true
      }
    });

    movedVariables.concat(args).forEach((varName) => {
      const mappedPropName = `0${varName}`;
      propMap[varName] = {
        get: function(this: any) {
          return this[mappedPropName];
        },
        set: function(this: Scope, val: any) {
          if (this["1map"] !== null && this["1map"].has(varName)) {
            var map = this["1map"].get(varName);
            window.$$addStackTrace(map, varName);
            if (val !== null && typeof(val) === "object") {
              this[mappedPropName] = window.$$getProxy(val, map);
            } else {
              this[mappedPropName] = val;
            }
          } else {
            this[mappedPropName] = val;
          }
        }
      };
      propMap[mappedPropName] = {
        value: null,
        enumerable: true
      };
    });

    // Initialize arguments.
    args.forEach((argName, i) => {
      propMap[`0${argName}`].value = argValues[i];
    });

    return Object.create(parentScopeObject, propMap);
  }

  /**
   * Get all of the possible root objects for the given path.
   * @param p
   */
  function getPossibleRoots(p: SerializeableGCPath): any[] {
    const root = p.root;
    switch (root.type) {
      case RootType.GLOBAL: {
        return [window];
      }
      case RootType.DOM: {
        const elementType = root.elementType;
        const rootObjs: any[] = [];
        if (elementType.startsWith("HTML") && elementType.endsWith("Element")) {
          const tag = elementType.slice(4, -7).toLowerCase();
          const elements = document.getElementsByTagName(tag);
          for (let i = 0; i < elements.length; i++) {
            rootObjs.push(elements[i]);
          }
        }
        return rootObjs;
      }
    }
  }

  /**
   * Returns an evaluateable JavaScript string to access the object at the given path
   * from a root.
   * @param p
   */
  function getAccessString(p: SerializeableGCPath): string {
    let accessStr = "root";
    const path = p.path;
    for (const l of path) {
      switch(l.type) {
        case EdgeType.CLOSURE:
          accessStr += `.__scope__['${l.indexOrName}']`;
          break;
        case EdgeType.INDEX:
        case EdgeType.NAMED:
          accessStr += `['${safeString(`${l.indexOrName}`)}']`;
          break;
      }
    }
    return accessStr;
  }


  const stackTraces = new Map<SerializeableGCPath, Map<string | number | symbol, Set<string>>>();
  function addStack(map: Map<string | number | symbol, Set<string>>, property: string | number | symbol): void {
    try {
      throw new Error();
    } catch (e) {
      let set = map.get(property);
      if (!set) {
        set = new Set<string>();
        map.set(property, set);
      }
      set.add(e.stack);
    }
  }
  function removeStacks(map: Map<string | number | symbol, Set<string>>, property: string | number | symbol): void {
    if (map.has(property)) {
      map.delete(property);
    }
  }
  function getProxy(obj: any, map: Map<string | number | symbol, Set<string>>): any {
    if (!obj.$$$PROXY$$$) {
      obj.$$$PROXY$$$ = new Proxy(obj, {
        defineProperty: function(target, property, descriptor): boolean {
          if (!disableProxies) {
            // Capture a stack trace.
            addStack(map, property);
          }
          return Reflect.defineProperty(target, property, descriptor);
        },
        set: function(target, property, value, receiver): boolean {
          if (!disableProxies) {
            // Capture a stack trace.
            addStack(map, property);
          }
          return Reflect.set(target, property, value, receiver);
        },
        get: function(target, property, receiver): any {
          if (property === secretStackMapProperty) {
            return map;
          } else if (property === secretIsProxyProperty) {
            return true;
          } else {
            return Reflect.get(target, property, receiver);
          }
        },
        deleteProperty: function(target, property): boolean {
          if (!disableProxies) {
            // Remove stack traces that set this property.
            removeStacks(map, property);
          }
          return Reflect.deleteProperty(target, property);
        }
      });
    }
    return obj.$$$PROXY$$$;
  }

  function replaceObjectsWithProxies(roots: any[], accessStr: string, map: Map<string | number | symbol, Set<string>>): void {
    const replaceFcn = new Function("root", "getProxy", "map", `try {
      ${accessStr} = getProxy(${accessStr}, map);
    } catch (e) {

    }`);
    roots.forEach((r) => replaceFcn(r, getProxy, map));
  }

  const secretStackMapProperty = "$$$stackmap$$$";
  const secretIsProxyProperty = "$$$isproxy$$$";
  // Disables proxy interception.
  let disableProxies = false;
  function instrumentPath(paths: SerializeableGCPath[]): void {
    // Check if first path is in map. If not, all paths should not be in map.
    let map = stackTraces.get(paths[0]);
    if (!map) {
      map = new Map<string | number | symbol, Set<string>>();
      // Use shortest (0th) path as canonical path.
      stackTraces.set(paths[0], map);
    }
    // Fetch the objects.
    for (const p of paths) {
      const accessString = getAccessString(p);
      const roots = getPossibleRoots(p);
      replaceObjectsWithProxies(roots, accessString, map);
    }
  }

  function instrumentPaths(p: SerializeableGCPath[][]): void {
    for (const path of p) {
      instrumentPath(path);
    }
  }

  function getStackTraces(): string {
    const rv: {[p: string]: {[prop: string]: string[]}} = {};
    stackTraces.forEach((value, key) => {
      const map: {[prop: string]: string[]} = rv[JSON.stringify(key)] = {};
      value.forEach((stacks, prop) => {
        const stackArray = new Array<string>(stacks.size);
        let i = 0;
        stacks.forEach((v) => {
          stackArray[i] = v;
          i++;
        });
        map[prop] = stackArray;
      });
    });
    return JSON.stringify(rv);
  }

  // Global variables.
  const root = <Window> (typeof(window) !== "undefined" ? window : global);
  root.$$instrumentPaths = instrumentPaths;
  root.$$getStackTraces = getStackTraces;
  root.$$addStackTrace = addStack;
  root.$$getProxy = getProxy;
  root.$$CREATE_SCOPE_OBJECT$$ = $$CREATE_SCOPE_OBJECT$$;

  if (typeof(window) !== "undefined") {
    // Disable these in NodeJS.

    EventTarget.prototype.addEventListener = function(this: EventTarget, type: string, listener: EventListenerOrEventListenerObject, useCapture: boolean = false) {
      addEventListener.apply(this, arguments);
      if (!this.$$listeners) {
        this.$$listeners = {};
      }
      let listeners = this.$$listeners[type];
      if (!listeners) {
        listeners = this.$$listeners[type] = [];
      }
      for (const listenerInfo of listeners) {
        if (listenerInfo.listener === listener && listenerInfo.useCapture === useCapture) {
          return;
        }
      }
      listeners.push({
        listener: listener,
        useCapture: useCapture
      });
    };

    EventTarget.prototype.removeEventListener = function(this: EventTarget, type: string, listener: EventListenerOrEventListenerObject, useCapture: boolean = false) {
      removeEventListener.apply(this, arguments);
      if (this.$$listeners) {
        const listeners = this.$$listeners[type];
        if (listeners) {
          for (let i = 0; i < listeners.length; i++) {
            const lInfo = listeners[i];
            if (lInfo.listener === listener && lInfo.useCapture === useCapture) {
              listeners.splice(i, 1);
              if (listeners.length === 0) {
                delete this.$$listeners[type];
              }
              return;
            }
          }
        }
      }
    };

    // Array modeling
    Array.prototype.push = (function(push) {
      return function(this: Array<any>, ...items: any[]): number {
        try {
          disableProxies = true;
          if ((<any> this)[secretIsProxyProperty]) {
            const map: Map<string | number | symbol,  Set<string>> = (<any> this)[secretStackMapProperty];
            for (let i = 0; i < items.length; i++) {
              addStack(map, `${this.length + i}`);
            }
          }
          return push.apply(this, items);
        } finally {
          disableProxies = false;
        }
      };
    })(Array.prototype.push);

    Array.prototype.unshift = (function(unshift) {
      return function(this: Array<any>, ...items: any[]): number {
        try {
          disableProxies = true;
          if ((<any> this)[secretIsProxyProperty]) {
            const map: Map<string | number | symbol,  Set<string>> = (<any> this)[secretStackMapProperty];
            const newItemLen = items.length;
            for (let i = items.length - 1; i >= 0; i--) {
              map.set(`${i + newItemLen}`, map.get(`${i}`));
            }
            for (let i = 0; i < items.length; i++) {
              removeStacks(map, `${i}`);
              addStack(map, `${i}`);
            }
          }
          return unshift.apply(this, items);
        } finally {
          disableProxies = false;
        }
      };
    })(Array.prototype.unshift);

    Array.prototype.pop = (function(pop) {
      return function(this: Array<any>): any {
        try {
          disableProxies = true;
          if ((<any> this)[secretIsProxyProperty]) {
            const map: Map<string | number | symbol,  Set<string>> = (<any> this)[secretStackMapProperty];
            removeStacks(map, `${this.length - 1}`);
          }
          return pop.apply(this);
        } finally {
          disableProxies = false;
        }
      };
    })(Array.prototype.pop);

    Array.prototype.shift = (function(shift) {
      return function(this: Array<any>): any {
        try {
          disableProxies = true;
          if ((<any> this)[secretIsProxyProperty]) {
            const map: Map<string | number | symbol,  Set<string>> = (<any> this)[secretStackMapProperty];
            removeStacks(map, "0");
            for (let i = 1; i < this.length; i++) {
              map.set(`${i - 1}`, map.get(`${i}`));
            }
            removeStacks(map, `${this.length - 1}`);
          }
          return shift.apply(this);
        } finally {
          disableProxies = false;
        }
      };
    })(Array.prototype.shift);

    Array.prototype.splice = (function(splice) {
      return function(this: Array<any>, start: number, deleteCount: number, ...items: any[]): any {
        try {
          disableProxies = true;
          if ((<any> this)[secretIsProxyProperty]) {
            const map: Map<string | number | symbol,  Set<string>> = (<any> this)[secretStackMapProperty];
            let actualStart = start | 0;
            if (actualStart === undefined) {
              return [];
            }
            // If greater than the length of the array, actual starting index will be set to the length of the array.
            if (actualStart > this.length) {
              actualStart = this.length;
            }
            // If negative, will begin that many elements from the end of the array (with origin 1)
            // and will be set to 0 if absolute value is greater than the length of the array.
            if (actualStart < 0) {
              actualStart = this.length + actualStart;
              if (actualStart < 0) {
                actualStart = 0;
              }
            }
            let actualDeleteCount = deleteCount | 0;
            // If deleteCount is omitted, or if its value is larger than array.length - start,
            //   then all of the elements beginning with start index on through the end of the array will be deleted.
            if (deleteCount === undefined || actualDeleteCount > this.length - actualStart) {
              actualDeleteCount = this.length - actualStart;
            }
            if (actualDeleteCount < 0) {
              actualDeleteCount = 0;
            }

            for (let i = 0; i < actualDeleteCount; i++) {
              const index = actualStart + i;
              removeStacks(map, `${index}`);
            }

            // Move existing traces into new locations.
            const newItemCount = items.length;
            if (newItemCount > actualDeleteCount) {
              // Shift *upward*
              const delta = newItemCount - actualDeleteCount;
              for (let i = this.length - 1; i >= actualStart + actualDeleteCount; i--) {
                map.set(`${i + delta}`, map.get(`${i}`));
              }
            } else if (newItemCount < actualDeleteCount) {
              // Shift *downward*
              const delta = newItemCount - actualDeleteCount;
              for (let i = actualStart + actualDeleteCount; i < this.length; i++) {
                map.set(`${i + delta}`, map.get(`${i}`));
              }
              // Delete extra traces for removed indexes.
              for (let i = this.length + delta; i < this.length; i++) {
                removeStacks(map, `${i}`);
              }
            }

            // Add new traces for new items.
            for (let i = 0; i < newItemCount; i++) {
              removeStacks(map, `${actualStart + i}`);
              addStack(map, `${actualStart + i}`);
            }
          }
          return splice.apply(this, arguments);
        } finally {
          disableProxies = false;
        }
      };
    })(Array.prototype.splice);

    // TODO: Sort, reverse, ...
  }
})();