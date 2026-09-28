# @di-framework/cli-plugin-ai

Agent configuration and Agent Skills commands for the `di-framework` CLI.

```sh
di-framework extensions install ai
```

That installs `@di-framework/cli-plugin-ai` and mounts `di-framework ai`. The commands resolve `@di-framework/ai-utils` from the current project.

```sh
di-framework ai agent audit
di-framework ai agent init --asset AGENTS.md --apply
di-framework ai agent inspect
di-framework ai agent migrate --plan
di-framework ai skills validate
di-framework ai skills index build --skills-dir ./.agents/skills --output ./.di-framework/skills-index.json
di-framework ai skills index query --input ./.di-framework/skills-index.json --query 'review authorization'
```

`agent audit`, `agent inspect`, and the default `agent migrate` / `agent init` modes do not write files. `--apply` writes the plan from that same invocation. Skills index validation drift and query abstention exit `1`. Invalid options exit `2`. A missing `@di-framework/ai-utils` install, or an unexpected operation failure, exits `3`.
