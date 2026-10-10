import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { HumanMessage } from '@langchain/core/messages';
import * as dotenv from 'dotenv';

dotenv.config();

export class OCRService {
  /**
   * Extracts text, code snippets, and instructions from a Base64 screenshot image using Gemini Vision.
   * @param imagePayload Base64 data URL (e.g. data:image/png;base64,...)
   */
  public async extractTextFromImage(imagePayload: string): Promise<string> {
    if (!imagePayload || typeof imagePayload !== 'string') {
      return '';
    }

    console.log('[OCRService] 🔍 Extracting text from attached screenshot image...');

    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (geminiApiKey && geminiApiKey !== 'your_gemini_api_key_here') {
      const visionCandidates = [
        'gemini-2.5-flash',
        'gemini-2.0-flash',
        'gemini-1.5-flash',
        'gemini-1.5-pro'
      ];

      for (const visionModelName of visionCandidates) {
        try {
          const model = new ChatGoogleGenerativeAI({
            model: visionModelName,
            temperature: 0.1,
            apiKey: geminiApiKey
          });

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

          const response = await model.invoke([message]);
          const resAny = response as any;
          const rawContent = resAny?.content ?? response;
          const extractedText = typeof rawContent === 'string'
            ? rawContent.trim()
            : JSON.stringify(rawContent);

          if (extractedText) {
            console.log(`[OCRService] ✔ Vision OCR Extraction Complete via '${visionModelName}':`, extractedText.substring(0, 150) + '...');
            return extractedText;
          }
        } catch (err: any) {
          console.warn(`[OCRService] Vision model '${visionModelName}' OCR call failed:`, err?.message || err);
        }
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
