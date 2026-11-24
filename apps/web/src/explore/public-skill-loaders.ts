import { createServerFn } from "@tanstack/react-start";

import { getPublicSkillPage } from "./public-skill-catalog.server";
import { validatePublicSkillsSearch } from "./public-skills";

export const browsePublicSkills = createServerFn({ method: "GET" })
  .validator(validatePublicSkillsSearch)
  .handler(({ data }) => getPublicSkillPage(data));
