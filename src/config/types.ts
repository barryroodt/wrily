export type ReviewMode = 'auto' | 'single' | 'team';
export type ReviewType = 'full' | 'delta';
export type Style = 'terse' | 'verbose';
export type Sensitivity = 'minor' | 'important' | 'critical';
export type Model = 'opus' | 'sonnet' | 'haiku' | string;

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
  authMethod: 'oauth' | 'api_key';
  anthropicApiKey: string | null;
  claudeCodeOauthToken: string | null;
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
