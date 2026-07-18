import {prisma} from "../lib/prisma.js";
import type { DbClient } from "../types/db-client.type.js";

export const permissionRepository = {
  create :(
    data : {
      tenantId : string;
      agentId : string;
      toolId : string;
    },
    client : DbClient = prisma
  )=> client.agentToolPermission.create({data}),

  // returns a list of permissions for a given agent of a particular tenant
  listByAgentId : (
    agentId : string,
    tenantId : string,
    client : DbClient = prisma
  ) => client.agentToolPermission.findMany(
    {
      where : {agentId , tenantId} ,
      orderBy : {createdAt : "desc"}
    }
  ),


  // deactivates a permission for a given agent, tool, and tenant
  deactivate : (
    agentId : string,
    toolId : string,
    tenantId : string,
    client : DbClient = prisma
  )=> client.agentToolPermission.updateMany(
    {
      where : {agentId , toolId , tenantId} ,
      data : {isActive : false}
    }
  ),

  // hot-path look up for a permission for a given agent, tool, and tenant . we fetch data in a sequence like this : does a permission row for this exact set exist -> if yes , the return the row that includes the isActive status of agent and tool and delete status of tenant -> these info will be used by the service layer to determine the permission status
  findGrantWithContext : (
    agentId : string,
    toolId : string,
    tenantId : string,
    client : DbClient = prisma
  ) => client.agentToolPermission.findFirst({
    where : {agentId , toolId , tenantId} ,
    include : {
      agent : {select : {isActive : true}} ,
      tool : {select : {isActive : true}} ,
      tenant: { select: { deletedAt: true } } // {<field> : true } -> means include this filed in the returned row
    }
  })

}