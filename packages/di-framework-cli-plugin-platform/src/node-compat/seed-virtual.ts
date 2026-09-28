/** Guest Node state. Replaced at bundle time with project files and env. */
export const nodeCompatSeed: {
  files: Record<string, string>;
  environ: Record<string, string>;
  cwd: string;
} = {
  files: {},
  environ: {},
  cwd: '/',
};
