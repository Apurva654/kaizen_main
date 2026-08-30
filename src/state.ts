export interface PlanStep {
  id: number;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

export interface KaizenStateType {
  userInput: string;
  targetFiles: string[];
  extractedContext: string;
  plan: PlanStep[];
  generatedPatch: string;
  choices: string[];
  retryCount: number;
  status: string;
}

export const KaizenState = {
  
  State: {} as KaizenStateType
};
