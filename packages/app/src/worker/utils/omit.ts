export function omitResAndReq<
  T extends Record<string, unknown>
> (o: T): Omit<T, 'req' | 'res'> {
  const { req, res, ...rest } = o;
  return rest;
};
