// Voice alerts via on-device speech synthesis. No network, no keys.
// Never throws: returns false when unsupported or blocked.
export function voiceSupported() {
  try {
    return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
  } catch (e) { return false; }
}
export function speak(text) {
  try {
    if (!voiceSupported() || !text) return false;
    const utter = new SpeechSynthesisUtterance(String(text));
    utter.lang = 'uk-UA';
    utter.rate = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
    return true;
  } catch (e) { return false; }
}
export function stopVoice() {
  try { if (voiceSupported()) window.speechSynthesis.cancel(); } catch (e) {}
}
