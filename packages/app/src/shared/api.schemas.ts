import * as v from 'valibot';

export const ErrorResponse = v.pipe(
  v.object({ error: v.string() }),
  v.metadata({ ref: 'ErrorResponse' }),
);
