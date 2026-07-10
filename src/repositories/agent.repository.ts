import {prisma} from "../lib/prisma.js"
import type {DbClient} from "../types/db-client.type.js"

export const agentRepository = {
  create : (
    data :{
      tenantId : string,
      name : string,
      description? : string,
      apiKeyId : string,
      apiKeyHash : string,
      createdBy : string;
    },
    client : DbClient = prisma
  ) => client.agent.create({data}),

  findById : (
    id : string,
    tenantId : string,
    client : DbClient = prisma
  ) => client.agent.findFirst({where : {id, tenantId}}),

  /**
    The ONE lookup in this repository that does not take tenantId.
    This is intentional, not an oversight:
      - at SSE-connection time the caller does not know tenantId yet — that's what
      we're trying to establish.
      - `apiKeyId` is public (part of the bearer token) but unguessable (96 bits of randomness) and unique
    so it's safe as the sole lookup key here. Everything downstream must derive tenantId from the RETURNED ROW — never from client input.
   */
  findByKeyId: (apiKeyId: string, client: DbClient = prisma) =>
    client.agent.findFirst({ where: { apiKeyId, isActive: true } }),

  list: (tenantId: string, client: DbClient = prisma) =>
    client.agent.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
  }),

  // update general agent info (name, description, isActive) by id and tenantId
  updateById: (
    id: string,
    tenantId: string,
    data: Partial<{ name: string; description: string; isActive: boolean }>,
    client: DbClient = prisma
  ) => client.agent.updateMany({ where: { id, tenantId }, data }),

  // update the apiKeyId and apiKeyHash for an agent by id and tenantId
  // used updateMany as it returns rows count that been changed instead of the actual updated row . So , if the changed row count is 0 , it can lead to two scenarios : either tenantId and agentId combination is wrong or agent belongs to another agent .
  // no matter what the case is , it should return 404 in service layer to avoid leaking information about the existence of an agent in another tenant.
  rotateKey : (
    id : string,
    tenantId : string,
    data : { apiKeyId : string, apiKeyHash : string },
    client : DbClient = prisma
  ) => client.agent.updateMany({where : {id, tenantId}, data}),

  touchLastActive : (
    id : string,
    client : DbClient = prisma
  ) => client.agent.update({where : {id} , data : {lastActiveAt : new Date()}})

}


