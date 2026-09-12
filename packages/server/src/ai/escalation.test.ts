import { describe, expect, it } from "vitest";
import { EscalationDetector, parseVerdict } from "./escalation-detector.js";
import { FakeChatProvider } from "../providers/fake-chat-provider.js";

describe("escalation detector", () => {
  it("escalates an explicit request without consulting a model", async () => {
    // Deterministic and never overridable: when someone asks for a person, they
    // get queued for a person. Routing this through the model means it can be
    // reasoned away.
    const chat = new FakeChatProvider([{ reply: '{"escalate": false}' }]);
    const verdict = await new EscalationDetector(chat).detect({
      question: "this is useless, I want to talk to a human",
      answer: "Here is a doc link.",
      grounded: true,
      consecutiveUngrounded: 0,
    });
    expect(verdict.escalate).toBe(true);
    expect(verdict.trigger).toBe("rule");
    expect(chat.requests).toHaveLength(0);
  });

  it("escalates after repeated ungrounded turns", async () => {
    const chat = new FakeChatProvider([{ reply: '{"escalate": false}' }]);
    const verdict = await new EscalationDetector(chat).detect({
      question: "why did my charger stop",
      answer: "I do not know.",
      grounded: false,
      consecutiveUngrounded: 2,
    });
    expect(verdict.escalate).toBe(true);
    expect(verdict.trigger).toBe("low_confidence");
  });

  it("does not escalate a single ungrounded turn", async () => {
    const chat = new FakeChatProvider([{ reply: '{"escalate": false, "reason": "answered"}' }]);
    const verdict = await new EscalationDetector(chat).detect({
      question: "why did my charger stop",
      answer: "I do not know.",
      grounded: false,
      consecutiveUngrounded: 1,
    });
    expect(verdict.escalate).toBe(false);
  });

  it("uses the classifier verdict when no rule fires", async () => {
    const chat = new FakeChatProvider([
      { reply: '{"escalate": true, "reason": "refund dispute", "summary": "Wants money back", "urgency": "high"}' },
    ]);
    const verdict = await new EscalationDetector(chat).detect({
      question: "you charged me twice",
      answer: "Sorry about that.",
      grounded: true,
      consecutiveUngrounded: 0,
    });
    expect(verdict.escalate).toBe(true);
    expect(verdict.urgency).toBe("high");
    expect(verdict.summary).toBe("Wants money back");
  });

  it("does not escalate when the classifier itself fails", async () => {
    // Failing open here would mean a provider blip silently queues every
    // conversation to humans; failing closed on a real signal would be worse,
    // which is why the deterministic rules run first and never reach this path.
    const chat = new FakeChatProvider([{ reply: "", fail: true }]);
    const verdict = await new EscalationDetector(chat).detect({
      question: "how do I reset it",
      answer: "Hold the button.",
      grounded: true,
      consecutiveUngrounded: 0,
    });
    expect(verdict.escalate).toBe(false);
  });
});

describe("parseVerdict", () => {
  it("tolerates prose around the JSON, which weaker models emit", () => {
    const verdict = parseVerdict('Sure! {"escalate": true, "urgency": "low"} Hope that helps.');
    expect(verdict?.escalate).toBe(true);
    expect(verdict?.urgency).toBe("low");
  });

  it("returns null rather than guessing on unparseable output", () => {
    expect(parseVerdict("I think maybe yes")).toBeNull();
    expect(parseVerdict('{"escalate": "yes"}')).toBeNull();
    expect(parseVerdict("")).toBeNull();
  });

  it("defaults an unknown urgency instead of propagating it", () => {
    expect(parseVerdict('{"escalate": true, "urgency": "catastrophic"}')?.urgency).toBe(
      "normal",
    );
  });
});
