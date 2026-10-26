export const fail = (status, message, code = "agent_action_denied") => Object.assign(new Error(message), { status, code });
