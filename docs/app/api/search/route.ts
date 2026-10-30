import { source } from "@root/lib/source";
import { createFromSource } from "fumadocs-core/search/server";

export const { GET } = createFromSource(source);
