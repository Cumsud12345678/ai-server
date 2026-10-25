// Ödəniş provayderləri. Hazırda yalnız "manual" var: müştəri yükləmə sorğusu göndərir, admin ödənişi alıb təsdiq edir.
// Ödəniş şlüzü (API) alınanda yeni provayder qeydiyyatdan keçir və BILLING_PROVIDER=<ad> verilir; qalan hər şey (balans,
// jurnal, təkrar-qoruması) hazırdır. Provayder müqaviləsi:
//   name: string
//   createCheckout?({ tenantId, amountAzn, requestId }) → { url }        // müştərini ödəniş səhifəsinə göndərir
//   handleWebhook?(req) → { ref, tenantId, amountAzn, requestId? } | null // imzanı yoxlayır; etibarsızdırsa null
// Webhook ünvanı: POST /v1/billing/webhook/<ad>. Eyni ref ikinci dəfə pul əlavə etmir.
const registry = new Map();

export const manualProvider = {
  name: "manual",
  instructions: () => process.env.BILLING_MANUAL_INSTRUCTIONS || "",
};
registry.set("manual", manualProvider);

export const registerProvider = (p) => registry.set(p.name, p);
export const getProvider = (name) => registry.get(name);
export const activeProvider = () => registry.get(process.env.BILLING_PROVIDER || "manual") ?? manualProvider;
