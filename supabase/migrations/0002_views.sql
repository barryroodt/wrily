create view spend_by_repo_30d as
  select github_repo,
         count(*)        as runs,
         sum(cost_usd)   as cost_usd,
         sum(input_tokens + output_tokens) as total_tokens
  from review_runs
  where inserted_at > now() - interval '30 days'
    and status = 'success'
  group by github_repo
  order by cost_usd desc;

create view spend_by_model_30d as
  select model,
         review_mode,
         count(*)      as runs,
         sum(cost_usd) as cost_usd,
         avg(cost_usd) as avg_cost_usd
  from review_runs
  where inserted_at > now() - interval '30 days'
    and status = 'success'
  group by model, review_mode
  order by cost_usd desc;
