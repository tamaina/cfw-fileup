import type { describeRoute, describeResponse } from 'hono-openapi';
import type * as v from 'valibot';

export type ApiEndpointRequestType = ReturnType<typeof v['object']>;
export type ApiEndpointResponseType = Parameters<typeof describeResponse>[1];

export type ApiEndpointDefinition = {
  req: ApiEndpointRequestType;
  res: ApiEndpointResponseType;
} & Omit<Parameters<typeof describeRoute>[0], 'responses'>;

export type ApiEndpointDefinitionRecord = {
  [x: string]: ApiEndpointDefinition;
};
