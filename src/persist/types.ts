export type SubagentRecord = {
  role: string;
  model: string;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
};

export type ReviewRunRecord = {
  github_repo: string;
  pr_number: number;
  commit_sha: string;
  trigger_source: 'github_app' | 'local_cli';
  review_round: number;
  model: string;
  review_mode: 'single' | 'team';
  scope: 'full' | 'delta';
  max_tokens: number | null;
  status: 'success' | 'budget_exceeded' | 'timeout' | 'failed';
  duration_ms: number;
  findings_posted: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
};

export type CostsQuery = {
  sinceDays: number;
  repo?: string;
  by: 'repo' | 'model' | 'day';
};

export type CostsRow = Record<string, string | number>;

export type CostsResult = {
  rows: CostsRow[];
};
