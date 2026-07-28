import { Agent } from "undici";
import { defaultDnsResolver } from "./dns-security.js";
import {createSafeLookup} from "./safe-lookup.js"
import { CONNECTION_TIMEOUT_MS } from "../handlers/types.js";


let sharedSafeAgent : Agent | null = null ;

export function getSafeAgent() : Agent {
  if(!sharedSafeAgent){
    sharedSafeAgent = new Agent({
      connect : {
        lookup : createSafeLookup(defaultDnsResolver),
        timeout : CONNECTION_TIMEOUT_MS,
      },
      keepAliveTimeout : 1,
      keepAliveMaxTimeout : 1,
    })
  }

  return sharedSafeAgent;
}

export async function closeSafeAgent(): Promise<void> {
  if (sharedSafeAgent) {
    await sharedSafeAgent.close();
    sharedSafeAgent = null;
  }
}