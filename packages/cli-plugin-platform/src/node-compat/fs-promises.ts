import { promises } from './fs';

export const {
  access,
  appendFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} = promises;

export default promises;
