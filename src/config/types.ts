export type ReviewMode = 'auto' | 'single' | 'team';
export type ReviewType = 'full' | 'delta';
export type Style = 'terse' | 'verbose';
export type Sensitivity = 'minor' | 'important' | 'critical';
/**
 * A model reference. The canonical form is a `provider/model` slug
 * (e.g. `anthropic/claude-opus-4-8`); bare family aliases like `opus` are
 * accepted as input sugar and normalized to a slug by `resolveModel`.
 */
export type Model = string;

export type TeamThresholdUnit = 'files' | 'folders';

export type WrilyConfig = {
  model: Model;
  mode: ReviewMode;
  team_threshold: number;
  team_threshold_unit: TeamThresholdUnit;
  max_budget_usd: number | null;
  ignore: string[];
  shared_skills: string[];
  request_changes: boolean;
  style: Style;
  sensitivity: Sensitivity;
  reply_feedback: 'on' | 'off';
};

export type RuntimeEnv = {
  // Provider API keys, mirrored from the environment as parsed-env state.
  // pi reads provider keys from process.env at run time; these back the
  // auth gate and diagnostics. Bedrock auth is ambient (AWS creds) and not
  // represented here.
  anthropicApiKey?: string | null;
  openaiApiKey?: string | null;
  geminiApiKey?: string | null;
  googleCloudApiKey?: string | null;
  mistralApiKey?: string | null;
  azureOpenaiApiKey?: string | null;
  cloudflareApiKey?: string | null;
  githubToken: string;
  prNumber: number;
  githubRepository: string;
  baseBranch: string;
  commitSha: string;
  sharedRepo: string;
  sharedToken: string;
  wrilyBotLogin: string;
  reviewRoundIndex: number;
  scopeOverride: 'full' | 'delta' | '';
  modeOverride: '' | 'auto' | 'single' | 'team';
  modelOverride: string;
  maxBudgetOverride: number | null;
  dryRun: boolean;
  prAuthorLogin: string;
  triggerSource: string;
  actor: string;
  replyFeedbackOverride: '' | 'on' | 'off';
  supabase?: { url: string; serviceRoleKey: string } | null;
};
