/**
 * RFC 7591 dynamic client registration — public, because Claude.ai and ChatGPT
 * register themselves the first moment a user adds the connector, before anyone
 * has logged in. Registration grants nothing: a client can ask for an
 * authorization, and only a human approving on the consent screen turns that
 * into a token, scoped to their own membership role.
 */
import type { Request, Response } from "express";
import { createClient } from "./store";
import {
  AUTH_METHODS_SUPPORTED, normalizeAuthMethod, normalizeClientName, normalizeGrantTypes,
  normalizeResponseTypes, normalizeScope, validateRedirectUris,
} from "./validate";

export async function handleRegister(req: Request, res: Response) {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const name = normalizeClientName(body.client_name);
  if (!name.ok) return res.status(400).json({ error: name.error, error_description: name.description });

  const uris = validateRedirectUris(body.redirect_uris);
  if (!uris.ok) return res.status(400).json({ error: uris.error, error_description: uris.description });

  const responseTypes = normalizeResponseTypes(body.response_types);
  if (!responseTypes.ok) return res.status(400).json({ error: responseTypes.error, error_description: responseTypes.description });

  const grants = normalizeGrantTypes(body.grant_types);
  if (!grants.ok) return res.status(400).json({ error: grants.error, error_description: grants.description });

  const method = normalizeAuthMethod(body.token_endpoint_auth_method);
  if (!method.ok) return res.status(400).json({ error: method.error, error_description: method.description });

  const scope = normalizeScope(body.scope);
  if (!scope.ok) return res.status(400).json({ error: scope.error, error_description: scope.description });

  const { client, clientSecret } = await createClient({
    clientName: name.value,
    redirectUris: uris.value,
    grantTypes: grants.value,
    tokenEndpointAuthMethod: method.value,
  });

  res.status(201).json({
    client_id: client.clientId,
    client_id_issued_at: Math.floor(new Date(client.createdAt).getTime() / 1000),
    ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes,
    response_types: responseTypes.value,
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    scope: scope.value,
    token_endpoint_auth_methods_supported: [...AUTH_METHODS_SUPPORTED],
  });
}
