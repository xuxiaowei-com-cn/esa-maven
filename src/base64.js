/**
 * Basic 认证要求把 "username:password" 按 UTF-8 编码后再 Base64。
 * ESA 运行时提供 TextEncoder 和 btoa，直接使用即可。
 */
export function base64EncodeUtf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
