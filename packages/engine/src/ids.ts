let messageCounter = 0;

/** Shared id generator so every ChatMessage in a process gets a unique id, whichever module created it. */
export function nextMessageId(): string {
  messageCounter += 1;
  return `msg${messageCounter}`;
}
