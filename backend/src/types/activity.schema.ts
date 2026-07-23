import z from "zod";

const bulkActivity = z.object({
  title: z.string().min(1, { message: "Title is required" }),
  description: z.string().min(1, { message: "Description is required" }),
  taskTitle: z.string().min(1, { message: "Task title is required" }),
  taskDescription: z.string().min(1, { message: "Task Description title is required" }),
  visits: z.number().int().gte(0),
});

export const ActivityDetailsSchema = z.array(bulkActivity);
