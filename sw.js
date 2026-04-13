function injectPrompt(text) {
  document.getElementById('clamoInput').value = text;
  document.getElementById('clamoInput').focus();
}

function clamoSend() {
  const val = document.getElementById('clamoInput').value.trim();
  if (!val) return;
  // → branchez ici votre fonction d'envoi existante
  // ex : sendMessage(val);
}
