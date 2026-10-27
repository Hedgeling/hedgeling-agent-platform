// SPDX-License-Identifier: Apache-2.0
export class AgentError extends Error {
  constructor(status, message, code = 'agent_error') {
    super(message);
    this.name = 'AgentError';
    this.status = status;
    this.code = code;
  }
}

export const fail = (status, message, code) => new AgentError(status, message, code);
