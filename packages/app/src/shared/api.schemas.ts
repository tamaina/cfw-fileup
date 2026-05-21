import * as v from 'valibot';
import { MAX_ID_LENGTH } from './const.js';

export const IdString = v.pipe(
	v.string(),
	v.maxLength(MAX_ID_LENGTH),
	v.metadata({ ref: 'IdString' }),
);

export const ErrorResponse = v.pipe(
  v.object({ error: v.string() }),
  v.metadata({ ref: 'ErrorResponse' }),
);
