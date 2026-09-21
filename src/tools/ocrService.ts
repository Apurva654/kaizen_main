import { ChatGroq } from '@langchain/groq';
import { HumanMessage } from '@langchain/core/messages';
import * as dotenv from 'dotenv';

dotenv.config();

export class OCRService {
  private visionModel: ChatGroq | null = null;

  constructor() {
    const apiKey = process.env.GROQ_API_KEY;
    if (apiKey) {
      try {
        this.visionModel = new ChatGroq({
          model: 'llama-3.2-11b-vision-preview',
          temperature: 0.1,
          apiKey
        });
      } catch (err) {
        console.warn('[OCRService] Failed to initialize Vision LLM:', err);
      }
    }
  }

  /**
   * Extracts text, code snippets, and instructions from a Base64 screenshot image.
   * @param imagePayload Base64 data URL (e.g. data:image/png;base64,...)
   */
  public async extractTextFromImage(imagePayload: string): Promise<string> {
    if (!imagePayload || typeof imagePayload !== 'string') {
      return '';
    }

    console.log('[OCRService] 🔍 Extracting text from attached screenshot image...');

    if (this.visionModel) {
      try {
        const message = new HumanMessage({
          content: [
            {
              type: 'text',
              text: 'You are an OCR and Vision code reader. Extract and transcribe all visible text, code snippets, file names, error stack traces, and instructions from this screenshot. Return ONLY the extracted content with clear section headers if applicable.'
            },
            {
              type: 'image_url',
              image_url: {
                url: imagePayload
              }
            }
          ]
        });

        const response = await this.visionModel.invoke([message]);
        const resAny = response as any;
        const rawContent = resAny?.content ?? response;
        const extractedText = typeof rawContent === 'string' 
          ? rawContent.trim() 
          : JSON.stringify(rawContent);

        console.log('[OCRService] ✔ Vision OCR Extraction Complete:', extractedText.substring(0, 150) + '...');
        return extractedText;
      } catch (err: any) {
        console.warn('[OCRService] Vision model OCR call failed, using fallback reader:', err?.message || err);
      }
    }

    // Fallback text extraction if vision model unavailable
    return this.fallbackImageTextExtraction(imagePayload);
  }

  private fallbackImageTextExtraction(imagePayload: string): string {
    const metaMatch = imagePayload.match(/^data:image\/(\w+);base64,/);
    const format = metaMatch ? metaMatch[1] : 'unknown';
    const approxSizeKB = Math.round((imagePayload.length * 0.75) / 1024);

    return `[Attached Screenshot Summary: ${format.toUpperCase()} image (~${approxSizeKB} KB). Please review attached image context.]`;
  }
}

export const ocrService = new OCRService();
