import { handleRequest } from './maven-proxy.js';

export default {
  async fetch(request, context, env) {
    return handleRequest(request, env);
  },
};
