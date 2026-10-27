import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

export function fencedLanguage(info) {
  const label = info.trim().split(/\s+/)[0].toLowerCase();
  if (!label) return null;
  return LanguageDescription.matchLanguageName(languages, label, false)
    ?? LanguageDescription.matchFilename(languages, `code.${label}`);
}
