// Load environment variables from `.env` during local development only
if (process.env.NODE_ENV !== 'production') {
  require("dotenv").config();
}

const { PrismaClient } = require("@prisma/client")

const prisma = new PrismaClient();

async function main() {
    const notes = await prisma.note.findMany();
    console.log(notes);
}

main()
  .catch(console.error).finally(() => prisma.$disconnect());