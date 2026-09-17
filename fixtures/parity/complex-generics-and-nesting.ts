/*
 * Parity fixture: complex multi-line conditional generics, deeply nested if
 * statements, deep callback chains, and generic function signatures.
 */

// --- 1. Complex Generics with Deep Conditional Types -------------------------

export type DeepFlatten<T> = T extends readonly (infer Element)[]
    ? Element extends readonly (infer Nested)[]
        ? DeepFlatten<Nested>[]
        : Element extends object
          ? {
                [K in keyof Element]: DeepFlatten<Element[K]>;
            }
          : Element
    : T extends object
      ? {
            [K in keyof T]: DeepFlatten<T[K]>;
        }
      : T;

export type DeepUnwrap<T> =
    T extends Promise<infer R1>
        ? R1 extends Promise<infer R2>
            ? DeepUnwrap<R2>
            : R1 extends readonly (infer Item)[]
              ? Item extends Promise<infer R3>
                  ? DeepUnwrap<R3>[]
                  : Item extends object
                    ? {
                          [K in keyof Item]: DeepUnwrap<Item[K]>;
                      }
                    : Item[]
              : R1 extends object
                ? {
                      [K in keyof R1]: DeepUnwrap<R1[K]>;
                  }
                : R1
        : T extends object
          ? {
                [K in keyof T]: DeepUnwrap<T[K]>;
            }
          : T;

export type ReverseTuple<T extends readonly unknown[]> = T extends readonly [
    infer Head,
    ...infer Tail,
]
    ? Tail extends readonly unknown[]
        ? [...ReverseTuple<Tail>, Head]
        : [Head]
    : [];

export type SchemaValidation<TSchema> = TSchema extends {
    type: 'string';
    enum?: readonly (infer TEnum)[];
}
    ? TEnum extends string
        ? TEnum
        : string
    : TSchema extends {
            type: 'number';
            minimum?: number;
        }
      ? number
      : TSchema extends {
              type: 'object';
              properties: infer TProps;
          }
        ? TProps extends Record<string, unknown>
            ? {
                  -readonly [K in keyof TProps]: SchemaValidation<TProps[K]>;
              }
            : Record<string, unknown>
        : never;

export type EntityPatch<TEntity extends Record<string, unknown>> = {
    [K in keyof TEntity as K extends `meta_${string}` ? never : K]?: TEntity[K] extends object
        ? {
              [SubKey in keyof TEntity[K]]?: TEntity[K][SubKey];
          }
        : TEntity[K];
};

// --- 2. Complex Generics in Function Parameters and Return Types -------------

export interface EntityStore<TEntity extends { id: string }, TMeta> {
    findById(id: string): Promise<TEntity | null>;
    save(entity: TEntity, meta: TMeta): Promise<TEntity>;
    query(filter: (item: TEntity) => boolean): Promise<TEntity[]>;
}

export function createStore<
    TEntity extends { id: string; version: number },
    TMeta extends Record<string, unknown>,
>(
    name: string,
    initialEntries: TEntity[],
    validator: (entity: TEntity) => boolean
): EntityStore<TEntity, TMeta> {
    const records = new Map<string, { entity: TEntity; meta: TMeta }>();

    for (const entry of initialEntries) {
        if (validator(entry)) {
            records.set(entry.id, {
                entity: entry,
                meta: {} as TMeta,
            });
        }
    }

    return {
        findById: async (id: string): Promise<TEntity | null> => {
            const found = records.get(id);
            if (found) {
                return found.entity;
            }
            return null;
        },
        save: async (entity: TEntity, meta: TMeta): Promise<TEntity> => {
            if (!validator(entity)) {
                throw new Error(`Invalid entity ${name}`);
            }
            records.set(entity.id, { entity, meta });
            return entity;
        },
        query: async (filter: (item: TEntity) => boolean): Promise<TEntity[]> => {
            const out: TEntity[] = [];
            for (const val of records.values()) {
                if (filter(val.entity)) {
                    out.push(val.entity);
                }
            }
            return out;
        },
    };
}

// --- 3. Deeply Nested if / else if / else Branches --------------------------

export interface PolicyContext {
    user?: {
        roles?: string[];
    };
    [key: string]: unknown;
}

export function evaluatePolicy<TContext extends PolicyContext>(
    context: TContext,
    level: number,
    flags: { active?: boolean; strict?: boolean; dryRun?: boolean; bypass?: boolean }
): { allowed: boolean; reason: string } {
    if (flags.active) {
        if (!flags.bypass) {
            if (level > 0) {
                if (flags.strict) {
                    if (context.user && typeof context.user === 'object') {
                        if (Array.isArray(context.user.roles)) {
                            if (context.user.roles.includes('admin')) {
                                if (flags.dryRun) {
                                    return { allowed: true, reason: 'admin-dry-run' };
                                } else {
                                    return { allowed: true, reason: 'admin-enforced' };
                                }
                            } else if (context.user.roles.includes('operator')) {
                                if (level <= 5) {
                                    return { allowed: true, reason: 'operator-low-level' };
                                } else {
                                    return { allowed: false, reason: 'operator-level-exceeded' };
                                }
                            } else {
                                return { allowed: false, reason: 'insufficient-role' };
                            }
                        } else {
                            return { allowed: false, reason: 'missing-roles-array' };
                        }
                    } else {
                        return { allowed: false, reason: 'missing-user-context' };
                    }
                } else {
                    if (level < 10) {
                        return { allowed: true, reason: 'permissive-allow' };
                    } else {
                        return { allowed: false, reason: 'permissive-level-cap' };
                    }
                }
            } else {
                return { allowed: false, reason: 'zero-or-negative-level' };
            }
        } else {
            return { allowed: true, reason: 'bypassed' };
        }
    } else {
        return { allowed: false, reason: 'inactive-policy' };
    }
}

// --- 4. Deep Callback Chains and Asynchronous Pipelines ---------------------

export interface PipelineTask<TIn, TOut> {
    name: string;
    run(input: TIn, next: (err: Error | null, result: TOut) => void): void;
}

export function executeNestedCallbacks<TInput, TStep1, TStep2, TFinal>(
    input: TInput,
    task1: PipelineTask<TInput, TStep1>,
    task2: PipelineTask<TStep1, TStep2>,
    task3: PipelineTask<TStep2, TFinal>,
    onComplete: (err: Error | null, finalResult?: TFinal) => void
): void {
    task1.run(input, (err1, res1) => {
        if (err1) {
            onComplete(err1);
            return;
        }
        task2.run(res1, (err2, res2) => {
            if (err2) {
                onComplete(err2);
                return;
            }
            task3.run(res2, (err3, res3) => {
                if (err3) {
                    onComplete(err3);
                    return;
                }
                try {
                    onComplete(null, res3);
                } catch (catastrophic) {
                    onComplete(
                        catastrophic instanceof Error
                            ? catastrophic
                            : new Error(String(catastrophic))
                    );
                }
            });
        });
    });
}

export function executeAsyncChain<TRecord extends Record<string, unknown>>(
    initial: Promise<TRecord>,
    logger: (msg: string) => void
): Promise<{ processed: TRecord; steps: string[] }> {
    return initial
        .then(step1 => {
            logger('step 1 started');
            return Promise.resolve({ ...step1, step1Done: true }).then(step2 => {
                logger('step 2 started');
                return Promise.resolve({ ...step2, step2Done: true }).then(step3 => {
                    logger('step 3 started');
                    return Promise.resolve({ ...step3, step3Done: true }).then(finalStep => {
                        logger('pipeline complete');
                        return {
                            processed: finalStep,
                            steps: ['step1', 'step2', 'step3', 'final'],
                        };
                    });
                });
            });
        })
        .catch(err => {
            logger(`pipeline error: ${String(err)}`);
            throw err;
        });
}

export function aggregateTree<TItem extends { id: string; value: number; subItems?: TItem[] }>(
    items: TItem[]
): { sum: number; count: number } {
    return items
        .filter(item => {
            return item.value > 0;
        })
        .map(item => {
            if (item.subItems && item.subItems.length > 0) {
                const sub = aggregateTree(item.subItems);
                return {
                    sum: item.value + sub.sum,
                    count: 1 + sub.count,
                };
            }
            return {
                sum: item.value,
                count: 1,
            };
        })
        .reduce(
            (acc, curr) => {
                return {
                    sum: acc.sum + curr.sum,
                    count: acc.count + curr.count,
                };
            },
            { sum: 0, count: 0 }
        );
}

// --- 5. Nested Switch inside Control Flow with Generic Handlers --------------

export type Command<TPayload> =
    | { action: 'start'; payload: TPayload }
    | { action: 'pause'; payload: { reason: string } }
    | { action: 'stop'; payload: { exitCode: number } };

export function processCommand<TData>(
    cmd: Command<TData>,
    enabled: boolean
): { handled: boolean; detail?: string } {
    if (enabled) {
        switch (cmd.action) {
            case 'start': {
                if (cmd.payload !== undefined) {
                    return { handled: true, detail: 'started' };
                }
                break;
            }
            case 'pause': {
                if (cmd.payload.reason.length > 0) {
                    return { handled: true, detail: cmd.payload.reason };
                }
                break;
            }
            case 'stop': {
                if (cmd.payload.exitCode === 0) {
                    return { handled: true, detail: 'clean' };
                } else {
                    return { handled: true, detail: 'error' };
                }
            }
            default: {
                return { handled: false };
            }
        }
    }
    return { handled: false };
}
