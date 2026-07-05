import { createHash } from 'node:crypto';

export function sha256Hex(bufferOrString) {
  return createHash('sha256').update(bufferOrString).digest('hex');
}
