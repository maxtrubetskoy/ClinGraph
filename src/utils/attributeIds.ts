export function attributeIdFor(entityId: string, name: string): string {
  return `attribute:${encodeURIComponent(entityId)}:${encodeURIComponent(name)}`;
}
