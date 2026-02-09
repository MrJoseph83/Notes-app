import { z } from "zod";

const noteSchema = z.object({
  title: z
    .string()
    .min(1, "Title is required")
    .max(200, "Title too long"),
  content: z
    .string()
    .max(5000, "Content too long")
    .optional(),
});

module.exports = {
  noteSchema,
};
