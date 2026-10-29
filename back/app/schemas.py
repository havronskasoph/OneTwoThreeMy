from datetime import date, datetime
from typing import Any
from uuid import UUID

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    HttpUrl,
    field_validator,
    model_validator,
)


def _blank_to_none(value: object) -> object:
    if isinstance(value, str) and not value.strip():
        return None
    return value


class ParticipantCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=120)
    email: EmailStr

    @field_validator("email")
    @classmethod
    def lowercase_email(cls, value: str) -> str:
        return value.lower()


class ParticipantRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    email: str


class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    email: str
    name: str | None


class UserUpdate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str | None = Field(default=None, max_length=120)

    @field_validator("name", mode="before")
    @classmethod
    def blank_to_none(cls, value: object) -> object:
        return _blank_to_none(value)


class MeetingCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    title: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    call_link: HttpUrl | None = None
    place: str | None = Field(default=None, max_length=255)
    starts_at: AwareDatetime
    ends_at: AwareDatetime
    participant_ids: list[UUID] = []

    @field_validator("description", "call_link", "place", mode="before")
    @classmethod
    def blank_to_none(cls, value: object) -> object:
        return _blank_to_none(value)

    @model_validator(mode="after")
    def require_call_link_or_place(self) -> "MeetingCreate":
        if self.call_link is None and self.place is None:
            raise ValueError("Provide a call link, a place, or both")
        return self

    @model_validator(mode="after")
    def ends_after_start(self) -> "MeetingCreate":
        if self.ends_at <= self.starts_at:
            raise ValueError("The meeting must end after it starts")
        return self


class AgendaItem(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    topic: str = Field(min_length=1, max_length=200)
    owner: str | None = Field(default=None, max_length=254)
    minutes: int | None = Field(default=None, ge=1, le=480)

    @field_validator("owner", mode="before")
    @classmethod
    def blank_to_none(cls, value: object) -> object:
        return _blank_to_none(value)


class ActionItem(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    task: str = Field(min_length=1, max_length=500)
    owner: str | None = Field(default=None, max_length=254)
    due: date | None = None

    @field_validator("owner", "due", mode="before")
    @classmethod
    def blank_to_none(cls, value: object) -> object:
        return _blank_to_none(value)


class Agenda(BaseModel):
    items: list[AgendaItem] = Field(min_length=1, max_length=50)
    action_items: list[ActionItem] = Field(default=[], max_length=50)


class AiSuggestion(BaseModel):
    """What the parser suggested, stored as-is next to what the user saved."""

    agenda: dict[str, Any]
    model: str = Field(min_length=1, max_length=100)
    prompt_version: str = Field(min_length=1, max_length=50)
    # The pasted text, so a new prompt version can be evaluated on the same inputs later.
    input_text: str | None = Field(default=None, max_length=10_000)


class AgendaSave(BaseModel):
    agenda: Agenda
    ai_suggestion: AiSuggestion | None = None


class MeetingRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    title: str
    description: str | None
    call_link: str | None
    place: str | None
    starts_at: datetime
    ends_at: datetime
    owner_id: UUID | None
    participants: list[ParticipantRead]
    agenda: Agenda | None
    created_at: datetime
