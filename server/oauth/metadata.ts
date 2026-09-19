/**
 * Discovery documents: RFC 9728 (protected resource) and RFC 8414
 * (authorization server). PTD is both roles in one process — the resource
 * metadata points at this same origin as its authorization server.
 */
import type { Request } from "express";
import { baseUrl } from "../discovery";
import {
  AUTH_METHODS_SUPPORTED, CODE_CHALLENGE_METHODS_SUPPORTED, GRANT_TYPES_SUPPORTED,
  RESPONSE_TYPES_SUPPORTED, SCOPES_SUPPORTED,
} from "./validate";

/** The canonical resource identifier an access token is audience-bound to. */
export function resourceUri(base: string): string {
  return `${base}/mcp`;
}

export function protectedResourceMetadata(req: Request) {
  const base = baseUrl(req);
  return {
    resource: resourceUri(base),
    authorization_servers: [base],
    scopes_supported: [...SCOPES_SUPPORTED],
    bearer_methods_supported: ["header"],
    resource_name: "PTD — Plan Track Done (MCP)",
    resource_documentation: `${base}/llms.txt`,
  };
}

export function authorizationServerMetadata(req: Request) {
  const base = baseUrl(req);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: [...RESPONSE_TYPES_SUPPORTED],
    grant_types_supported: [...GRANT_TYPES_SUPPORTED],
    code_challenge_methods_supported: [...CODE_CHALLENGE_METHODS_SUPPORTED],
    token_endpoint_auth_methods_supported: [...AUTH_METHODS_SUPPORTED],
    revocation_endpoint_auth_methods_supported: [...AUTH_METHODS_SUPPORTED],
    scopes_supported: [...SCOPES_SUPPORTED],
    service_documentation: `${base}/llms.txt`,
  };
}

/** The header /mcp answers a missing token with, so a client can find all this. */
export function wwwAuthenticate(base: string): string {
  return `Bearer realm="ptd", resource_metadata="${base}/.well-known/oauth-protected-resource"`;
}
