export type ResponseLengthMode = 'short' | 'medium' | 'long' | 'unlimited';

export interface ResponsePolicy {
  style: string;
  responseLengthMode: ResponseLengthMode;
  hardMaxResponseChars: number | null;
  plainTextOnly: boolean;
}

export interface MemoryPolicy {
  enabled: boolean;
  maxFactsInPrompt: number;
  writePolicy: string;
}

export interface TaskConfig {
  key: string;
  name: string;
  systemPrompt: string;
  behaviorGuidelines: string[];
  allowedTools: string[];
  responsePolicy: ResponsePolicy;
  memoryPolicy: MemoryPolicy;
}
