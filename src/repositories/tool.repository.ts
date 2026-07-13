import type { Prisma } from "@prisma/client";
import type{ DbClient } from "../types/db-client.type.js";
import {prisma} from "../lib/prisma.js"


export const toolRepository = {
  create : (
    data : {
      tenantId : string;
      name : string;
      description? : string;
      category ?: string;
      handlerType : string; // immutable
      handlerConfig : string ; // encrypted ciphertext . immutable
      inputSchema : Prisma.InputJsonValue;
      outputSchema? : Prisma.InputJsonValue;
    },
    client : DbClient = prisma
  ) => client.tool.create({data}),


  findById: (id: string, tenantId: string, client: DbClient = prisma) =>
    client.tool.findFirst({ where: { id, tenantId } }),

  list: (tenantId: string, client: DbClient = prisma) =>
    client.tool.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" } }),

  updateProfile : (
    id : string,
    tenantId : string,
    data : Partial<{name : string , description : string | null ; category : string | null }>,
    client : DbClient = prisma
  ) => client.tool.updateMany({where : {id , tenantId} , data}),

  // a tool can't be deleted . It can either be deactivate or active . Also , if a user needs to change the handler_config of a tool then that tool would be deactivated and new tool would be generated using the new set of handler_config
  setActiveStatus: (
    id: string,
    tenantId: string,
    isActive: boolean,
    client: DbClient = prisma
  ) => client.tool.updateMany({ where: { id, tenantId }, data: { isActive } }
  ),

}
