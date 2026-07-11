import {agentRepository} from "../repositories/agent.repository.js";
import {generateApiKey , hashApiKeySecret} from "../lib/api-key.js";

export const agentService = {
  async createAgent(
    tenantId : string,
    createdBy : string,
    input : { name : string, description? : string }
  ){
    const {keyId, rawSecret, fullKey} = generateApiKey();

    const apiKeyHash = await hashApiKeySecret(rawSecret);

    try{
      const agent = await agentRepository.create({
        tenantId,
        name: input.name,
        description: input.description ?? null,
        apiKeyId: keyId,
        apiKeyHash,
        createdBy
      });

      return {
        agent : toPublicAgent(agent),
        apiKey : fullKey
      }
    }catch(err : any){
      if(err.code == "P2002" ){
        throw new Error("AGENT_NAME_TAKEN");
      }
      throw err;
    }
  },

  async listAgents(tenantId : string){
    const agents = await agentRepository.list(tenantId);

    return agents.map(toPublicAgent);
  },

  async getAgent(agentId : string, tenantId : string){
    const agent = await agentRepository.findById(agentId, tenantId);
    return agent ? toPublicAgent(agent) : null;
  },

  async updateAgent(
    id : string,
    tenantId : string,
    input : {name ?: string , description ?: string}
  ){
    const data: Partial<{
      name: string;
      description: string | null;
    }> = {};

    if (input.name !== undefined) {
      data.name = input.name;
    }

    if (input.description !== undefined) {
      data.description = input.description;
    }
    const updateCount = await agentRepository.updateProfile(id, tenantId, data);
    if (updateCount.count === 0) return null;

    return this.getAgent(id, tenantId);
  },

  // if deactivation is successful, returns true
  async deactivateAgent(id : string, tenantId : string){
    const updateCount = await agentRepository.setActiveStatus(id, tenantId, false);

    return updateCount.count > 0;
  },

  async reactivateAgent(id: string, tenantId: string) {
    const updateCount = await agentRepository.setActiveStatus(id, tenantId, true);
    if (updateCount.count === 0) return null;
    return this.getAgent(id, tenantId);   
  },

  async rotateAgentKey(
    id : string,
    tenantId : string
  ){

    const {keyId, rawSecret, fullKey} = generateApiKey();

    const apiKeyHash = await hashApiKeySecret(rawSecret);

    const updateCount = await agentRepository.rotateKey(id, tenantId, {apiKeyId : keyId, apiKeyHash});

    if (updateCount.count === 0) return null;

    return {
      apiKey : fullKey
    }

  },
}

function toPublicAgent(agent :{
  id : string,
  tenantId : string,
  name : string,
  description : string | null,
  isActive : boolean,
  createdBy : string,
  createdAt : Date,
  updatedAt : Date,
  lastActiveAt : Date | null;
}){
  const {id, tenantId, name, description, isActive, createdBy, createdAt, updatedAt, lastActiveAt} = agent;

  return {
    id,
    tenantId,
    name,
    description,
    isActive,
    createdBy,
    createdAt,
    updatedAt,
    lastActiveAt
  }
}
