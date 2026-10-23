import skill from "../skills/solobooks/SKILL.md" with { type: "text" };
import approvals from "../skills/solobooks/references/approvals.md" with { type: "text" };
import billing from "../skills/solobooks/references/billing.md" with { type: "text" };
import money from "../skills/solobooks/references/money.md" with { type: "text" };
import onboarding from "../skills/solobooks/references/onboarding.md" with { type: "text" };
import priorData from "../skills/solobooks/references/prior-data.md" with { type: "text" };

/**
 * The agent guide, built into the binary so `solobooks setup` can copy it into the folders agents read.
 * Paths are relative to the skill's own folder. A test checks this matches skills/solobooks/ file for file.
 */
export const SKILL_FILES: Readonly<Record<string, string>> = {
  "SKILL.md": skill,
  "references/approvals.md": approvals,
  "references/billing.md": billing,
  "references/money.md": money,
  "references/onboarding.md": onboarding,
  "references/prior-data.md": priorData,
};

export const SKILL_NAME = "solobooks";
