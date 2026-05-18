import type { describeRoute, describeResponse } from 'hono-openapi';
import type * as v from 'valibot';

export type ApiEndpointDefinition = {
  req: ReturnType<typeof v['object']>;
  res: Parameters<typeof describeResponse>[1];
} & Omit<Parameters<typeof describeRoute>[0], 'responses'>;

export type ApiEndpointDefinitionRecord = {
  [x: string]: ApiEndpointDefinition;
};
