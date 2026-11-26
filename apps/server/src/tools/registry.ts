import { z } from 'zod';
import type { ToolName } from '@acme/contracts';
import type { ToolSpec } from '../llm/types';
import { billingHistoryTool } from './billing-history';
import { createTicketTool } from './create-ticket';
import { issueRefundTool } from './issue-refund';
import { searchKnowledgeBaseTool } from './search-knowledge-base';
import type { ToolDefinition, ToolDeps } from './types';
import { updateAccountTool } from './update-account';
import { verifyCustomerTool } from './verify-customer';

export type ToolRegistry = ReadonlyMap<ToolName, ToolDefinition>;

export function createToolRegistry(deps: ToolDeps): ToolRegistry {
  const tools = [
    verifyCustomerTool(deps),
    searchKnowledgeBaseTool(deps),
    billingHistoryTool(deps),
    issueRefundTool(deps),
    updateAccountTool(deps),
    createTicketTool(deps),
  ];
  return new Map(tools.map((t) => [t.name, t]));
}

/** JSON Schema for the model, generated from the same zod schema that validates the call. */
export function toolSpecs(registry: ToolRegistry): ToolSpec[] {
  return [...registry.values()].map((t) => {
    const { $schema: _ignored, ...parameters } = z.toJSONSchema(t.schema) as Record<string, unknown>;
    return { name: t.name, description: t.description, parameters };
  });
}
