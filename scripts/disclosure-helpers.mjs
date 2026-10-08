// Expand progressive-disclosure ancestors through the same controls as a user.
// The target itself may be a closed details element; only its ancestors open.
export async function reveal(locator) {
  await locator.waitFor({ state: 'attached' });
  const ancestors = await locator.locator('xpath=ancestor::details').all();
  for (const details of ancestors) {
    if (!await details.evaluate(node => node.open)) await details.locator('xpath=./summary').click();
  }
  await locator.waitFor({ state: 'visible' });
  return locator;
}
