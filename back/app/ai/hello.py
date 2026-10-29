"""`make llm-hello`: one call to Claude on Bedrock from the laptop; prints the answer, stop_reason, usage."""

from app.ai.agenda import client
from app.config import settings


def main() -> None:
    msg = client().messages.create(
        model=settings.parser_model,
        max_tokens=1024,
        output_config={"effort": "low"},  # short, cheap answers
        messages=[{"role": "user", "content": "In one sentence: what is an ISO week?"}],
    )
    print(next(b.text for b in msg.content if b.type == "text"))
    print(msg.stop_reason, msg.usage.input_tokens, msg.usage.output_tokens)


if __name__ == "__main__":
    main()
