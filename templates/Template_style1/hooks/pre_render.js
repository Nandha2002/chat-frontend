export default function preRender(values) {
  if (!Array.isArray(values.predefinedQuestions) || values.predefinedQuestions.length === 0) {
    throw new Error("Please provide at least one predefined question.");
  }
  values.predefinedQuestions = values.predefinedQuestions.map(q => q.trim());
  return values;
}
