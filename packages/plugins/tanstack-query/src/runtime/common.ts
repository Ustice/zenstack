/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { deserialize, serialize } from '@zenstackhq/runtime/browser';
import {
    applyMutation,
    getMutatedModels,
    getReadModels,
    type ModelMeta,
    type PrismaWriteActionType,
} from '@zenstackhq/runtime/cross';
import * as crossFetch from 'cross-fetch';

/**
 * The default query endpoint.
 */
export const DEFAULT_QUERY_ENDPOINT = '/api/model';

/**
 * Prefix for react-query keys.
 */
export const QUERY_KEY_PREFIX = 'zenstack';

/**
 * Function signature for `fetch`.
 */
export type FetchFn = (url: string, options?: RequestInit) => Promise<Response>;

/**
 * Context type for configuring the hooks.
 */
export type APIContext = {
    /**
     * The endpoint to use for the queries.
     */
    endpoint?: string;

    /**
     * A custom fetch function for sending the HTTP requests.
     */
    fetch?: FetchFn;

    /**
     * If logging is enabled.
     */
    logging?: boolean;
};

export async function fetcher<R, C extends boolean>(
    url: string,
    options?: RequestInit,
    fetch?: FetchFn,
    checkReadBack?: C
): Promise<C extends true ? R | undefined : R> {
    const _fetch = fetch ?? crossFetch.fetch;
    const res = await _fetch(url, options);
    if (!res.ok) {
        const errData = unmarshal(await res.text());
        if (
            checkReadBack !== false &&
            errData.error?.prisma &&
            errData.error?.code === 'P2004' &&
            errData.error?.reason === 'RESULT_NOT_READABLE'
        ) {
            // policy doesn't allow mutation result to be read back, just return undefined
            return undefined as any;
        }
        const error: Error & { info?: unknown; status?: number } = new Error(
            'An error occurred while fetching the data.'
        );
        error.info = errData.error;
        error.status = res.status;
        throw error;
    }

    const textResult = await res.text();
    try {
        return unmarshal(textResult).data as R;
    } catch (err) {
        console.error(`Unable to deserialize data:`, textResult);
        throw err;
    }
}

type QueryKey = [
    string /* prefix */,
    string /* model */,
    string /* operation */,
    unknown /* args */,
    {
        infinite: boolean;
        optimisticUpdate: boolean;
    } /* flags */
];

/**
 * Computes query key for the given model, operation and query args.
 * @param model Model name.
 * @param urlOrOperation Prisma operation (e.g, `findMany`) or request URL. If it's a URL, the last path segment will be used as the operation name.
 * @param args Prisma query arguments.
 * @param infinite Whether the query is infinite.
 * @param optimisticUpdate Whether the query is optimistically updated.
 * @returns Query key
 */
export function getQueryKey(
    model: string,
    urlOrOperation: string,
    args: unknown,
    infinite = false,
    optimisticUpdate = false
): QueryKey {
    if (!urlOrOperation) {
        throw new Error('Invalid urlOrOperation');
    }
    const operation = urlOrOperation.split('/').pop();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return [QUERY_KEY_PREFIX, model, operation!, args, { infinite, optimisticUpdate }];
}

export function marshal(value: unknown) {
    const { data, meta } = serialize(value);
    if (meta) {
        return JSON.stringify({ ...(data as any), meta: { serialization: meta } });
    } else {
        return JSON.stringify(data);
    }
}

export function unmarshal(value: string) {
    const parsed = JSON.parse(value);
    if (parsed.data && parsed.meta?.serialization) {
        const deserializedData = deserialize(parsed.data, parsed.meta.serialization);
        return { ...parsed, data: deserializedData };
    } else {
        return parsed;
    }
}

export function makeUrl(url: string, args: unknown) {
    if (!args) {
        return url;
    }

    const { data, meta } = serialize(args);
    let result = `${url}?q=${encodeURIComponent(JSON.stringify(data))}`;
    if (meta) {
        result += `&meta=${encodeURIComponent(JSON.stringify({ serialization: meta }))}`;
    }
    return result;
}

type InvalidationPredicate = ({ queryKey }: { queryKey: readonly unknown[] }) => boolean;
type InvalidateFunc = (predicate: InvalidationPredicate) => Promise<void>;
type MutationOptions = {
    onMutate?: (...args: any[]) => any;
    onSuccess?: (...args: any[]) => any;
    onSettled?: (...args: any[]) => any;
};

// sets up invalidation hook for a mutation
export function setupInvalidation(
    model: string,
    operation: string,
    modelMeta: ModelMeta,
    options: MutationOptions,
    invalidate: InvalidateFunc,
    logging = false
) {
    const origOnSuccess = options?.onSuccess;
    options.onSuccess = async (...args: unknown[]) => {
        const [_, variables] = args;
        const predicate = await getInvalidationPredicate(
            model,
            operation as PrismaWriteActionType,
            variables,
            modelMeta,
            logging
        );
        await invalidate(predicate);
        return origOnSuccess?.(...args);
    };
}

// gets a predicate for evaluating whether a query should be invalidated
async function getInvalidationPredicate(
    model: string,
    operation: PrismaWriteActionType,
    mutationArgs: any,
    modelMeta: ModelMeta,
    logging = false
) {
    const mutatedModels = await getMutatedModels(model, operation, mutationArgs, modelMeta);

    return ({ queryKey }: { queryKey: readonly unknown[] }) => {
        const [_, queryModel, , args] = queryKey as QueryKey;

        if (mutatedModels.includes(queryModel)) {
            // direct match
            if (logging) {
                console.log(`Invalidating query ${JSON.stringify(queryKey)} due to mutation "${model}.${operation}"`);
            }
            return true;
        }

        if (args) {
            // traverse query args to find nested reads that match the model under mutation
            if (findNestedRead(queryModel, mutatedModels, modelMeta, args)) {
                if (logging) {
                    console.log(
                        `Invalidating query ${JSON.stringify(queryKey)} due to mutation "${model}.${operation}"`
                    );
                }
                return true;
            }
        }

        return false;
    };
}

// find nested reads that match the given models
function findNestedRead(visitingModel: string, targetModels: string[], modelMeta: ModelMeta, args: any) {
    const modelsRead = getReadModels(visitingModel, modelMeta, args);
    return targetModels.some((m) => modelsRead.includes(m));
}

type QueryCache = {
    queryKey: readonly unknown[];
    state: {
        data: unknown;
        error: unknown;
    };
}[];

type SetCacheFunc = (queryKey: readonly unknown[], data: unknown) => void;

export function setupOptimisticUpdate(
    model: string,
    operation: string,
    modelMeta: ModelMeta,
    options: MutationOptions,
    queryCache: QueryCache,
    setCache: SetCacheFunc,
    invalidate?: InvalidateFunc,
    logging = false
) {
    const origOnMutate = options?.onMutate;
    const origOnSettled = options?.onSettled;

    // optimistic update on mutate
    options.onMutate = async (...args: unknown[]) => {
        const [variables] = args;
        await optimisticUpdate(
            model,
            operation as PrismaWriteActionType,
            variables,
            modelMeta,
            queryCache,
            setCache,
            logging
        );
        return origOnMutate?.(...args);
    };

    // invalidate on settled
    options.onSettled = async (...args: unknown[]) => {
        if (invalidate) {
            const [, , variables] = args;
            const predicate = await getInvalidationPredicate(
                model,
                operation as PrismaWriteActionType,
                variables,
                modelMeta,
                logging
            );
            await invalidate(predicate);
        }
        return origOnSettled?.(...args);
    };
}

// optimistically updates query cache
async function optimisticUpdate(
    mutationModel: string,
    mutationOp: string,
    mutationArgs: any,
    modelMeta: ModelMeta,
    queryCache: QueryCache,
    setCache: SetCacheFunc,
    logging = false
) {
    for (const cacheItem of queryCache) {
        const {
            queryKey,
            state: { data, error },
        } = cacheItem;

        if (error) {
            if (logging) {
                console.warn(`Skipping optimistic update for ${JSON.stringify(queryKey)} due to error:`, error);
            }
            continue;
        }

        const [_, queryModel, queryOp, _queryArgs, { optimisticUpdate }] = queryKey as QueryKey;
        if (!optimisticUpdate) {
            if (logging) {
                console.log(`Skipping optimistic update for ${JSON.stringify(queryKey)} due to opt-out`);
            }
            continue;
        }

        const mutatedData = await applyMutation(
            queryModel,
            queryOp,
            data,
            mutationModel,
            mutationOp as PrismaWriteActionType,
            mutationArgs,
            modelMeta,
            logging
        );

        if (mutatedData !== undefined) {
            // mutation applicable to this query, update cache
            if (logging) {
                console.log(
                    `Optimistically updating query ${JSON.stringify(
                        queryKey
                    )} due to mutation "${mutationModel}.${mutationOp}"`
                );
            }
            setCache(queryKey, mutatedData);
        }
    }
}
