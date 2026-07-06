import argon2 from "argon2";
import { prisma } from "../lib/prisma.js";
import {tenantRepository} from "../repositories/tenant.repository.js";
import {userRepository} from "../repositories/user.repository.js";
import {emailQueue} from "../queue/email.queue.js";

export const authService = {
  async registerTenant(data :{
    tenantName : string
    slug : string
    email : string
    password : string
  }){
    const existingUser = await tenantRepository.findBySlug(data.slug);
    if (existingUser) throw new Error("Tenant with this slug already exists");

    const hashedPassword = await argon2.hash(data.password);

    const verificationToken = crypto.randomUUID();

    const res = await prisma.$transaction(async (tx) =>{
      const tenant = await tenantRepository.create({
        name : data.tenantName,
        slug : data.slug,
      });

      const user = await userRepository.create({
        tenantId : tenant.id,
        email : data.email,
        passwordHash : hashedPassword,
        role : "owner",
        verificationToken : verificationToken,
      });

      return { tenant, user };
    })

    emailQueue.add("verification" , {
      type : "verification",
      email : data.email,
      token : verificationToken,
    }).catch((err) => {
      console.error("[EMAIL QUEUE] Failed to enqueue:", err);
    })

    return {
      tenant : res.tenant,
      user : {
        id : res.user.id,
        email : res.user.id,
        role : res.user.role
      }
    }


  },

  async verifyEmail(token : string){
    const user = await userRepository.findByVerificationToken(token);
    if (!user) throw new Error("Invalid verification token");
    await userRepository.updateVerified(user.id);
    return {
      verified : true,
    }
  }
}
