-- SPDX-License-Identifier: Apache-2.0
-- Preserve existing Gemini credentials and routing while allowing both accounts.
alter table organization_ai_credentials drop constraint organization_ai_credentials_pkey;
alter table organization_ai_credentials drop constraint organization_ai_credentials_provider_check;
alter table organization_ai_credentials add primary key(organization_id,provider);
alter table organization_ai_credentials add check(provider in ('gemini','meta'));
alter table organization_ai_settings add column translation_provider text not null default 'gemini'
  check(translation_provider in ('gemini','meta'));
update entitlement_definitions set description='Use organization Gemini or Meta keys for contextual translation'
  where key='ai_byok';
