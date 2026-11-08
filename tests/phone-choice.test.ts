/**
 * What the learner ticks on the phone (Learnbox 2.0, Slice 10h): courses and, of a course, subdecks — the pure rules:
 * the starting choice, the boxes, tri-state courses, what is sent, the totals and the lines under the boxes.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	choiceCounts,
	choiceOfAll,
	choiceOfHeld,
	choiceTotal,
	chosenCourses,
	chosenTopics,
	courseLine,
	courseTicks,
	subdeckChanges,
	subdecksOf,
	toggleCourse,
	toggleTopic,
	topicTicked,
} from "../components/mobile/phone-choice.ts";
import type { PhoneCatalogEntry } from "../src/core/index.ts";

const ANA: PhoneCatalogEntry = {
	id: "ana",
	name: "Anatomy",
	cards: 600,
	mediaBytes: 20_000_000,
	topics: [
		{ name: "W1 Head", cards: 100, mediaBytes: 6_000_000 },
		{ name: "W2 Arm", cards: 200, mediaBytes: 9_000_000 },
		{ name: "W10 Leg", cards: 250, mediaBytes: 8_000_000 },
		{ name: "", cards: 50, mediaBytes: 0 },
	],
};
const BIO: PhoneCatalogEntry = { id: "bio", name: "Biology", cards: 300, mediaBytes: 0, topics: [{ name: "W1 Cell", cards: 300, mediaBytes: 0 }] };
const CHEM: PhoneCatalogEntry = { id: "chem", name: "Chemistry", cards: 120, mediaBytes: 0 };
const ENTRIES = [ANA, BIO, CHEM];

describe("which subdecks a learner can tell apart", () => {
	it("is a course with at least two; a lone subdeck, or a list from before subdecks, is just the course", () => {
		assert.equal(subdecksOf(ANA)?.length, 4);
		assert.equal(subdecksOf(BIO), null);
		assert.equal(subdecksOf(CHEM), null);
		assert.equal(subdecksOf({ ...CHEM, topics: [] }), null);
	});
});

describe("the starting choice", () => {
	it("is every course held, whole, when the phone holds no subdeck choice", () => {
		const c = choiceOfHeld(["ana", "bio"]);
		assert.deepEqual([courseTicks(ANA, c), courseTicks(BIO, c), courseTicks(CHEM, c)], ["all", "all", "none"]);
		assert.deepEqual(chosenCourses(ENTRIES, c), ["ana", "bio"]);
		assert.deepEqual(chosenTopics(ENTRIES, c), {});
	});

	it("keeps the subdecks held of a course held in part", () => {
		const c = choiceOfHeld(["ana", "bio"], { ana: ["W1 Head", "W10 Leg"] });
		assert.equal(courseTicks(ANA, c), "some");
		assert.deepEqual([topicTicked(ANA, c, "W1 Head"), topicTicked(ANA, c, "W2 Arm"), topicTicked(ANA, c, "W10 Leg"), topicTicked(ANA, c, "")], [true, false, true, false]);
		assert.deepEqual(chosenTopics(ENTRIES, c), { ana: ["W1 Head", "W10 Leg"] });
	});

	it("takes a list that covers every subdeck for the whole course — and sends it as that", () => {
		const c = choiceOfHeld(["ana"], { ana: ["W1 Head", "W2 Arm", "W10 Leg", "", "W99 gone"] });
		assert.equal(courseTicks(ANA, c), "all");
		assert.deepEqual(chosenTopics(ENTRIES, c), {});
	});

	it("is every course the Mac has, whole, on the first run", () => {
		const c = choiceOfAll(ENTRIES);
		assert.deepEqual(chosenCourses(ENTRIES, c), ["ana", "bio", "chem"]);
		assert.deepEqual(chosenTopics(ENTRIES, c), {});
	});

	it("does not choose a course the Mac no longer lists", () => {
		assert.deepEqual(chosenCourses([BIO], choiceOfHeld(["ana", "bio"])), ["bio"]);
	});
});

describe("the boxes", () => {
	it("a course box takes a whole course off, and puts it back whole; on a course in part it makes it whole", () => {
		let c = choiceOfHeld(["ana"]);
		c = toggleCourse(c, ANA);
		assert.equal(courseTicks(ANA, c), "none");
		c = toggleCourse(c, ANA);
		assert.equal(courseTicks(ANA, c), "all");
		c = toggleTopic(c, ANA, "W2 Arm");
		assert.equal(courseTicks(ANA, c), "some");
		c = toggleCourse(c, ANA);
		assert.equal(courseTicks(ANA, c), "all", "an unfinished tick is finished by the course box");
		assert.deepEqual(chosenTopics(ENTRIES, c), {});
	});

	it("a subdeck box takes one subdeck out of a whole course, and back in", () => {
		let c = choiceOfHeld(["ana"]);
		c = toggleTopic(c, ANA, "W2 Arm");
		assert.deepEqual(chosenTopics(ENTRIES, c), { ana: ["W1 Head", "W10 Leg", ""] }, "in the Mac's order");
		assert.equal(courseTicks(ANA, c), "some");
		c = toggleTopic(c, ANA, "W2 Arm");
		assert.equal(courseTicks(ANA, c), "all", "the last box back makes the course whole again");
		assert.deepEqual(chosenTopics(ENTRIES, c), {});
	});

	it("the last subdeck unticked takes the course off the phone", () => {
		let c = choiceOfHeld(["ana"], { ana: ["W1 Head"] });
		c = toggleTopic(c, ANA, "W1 Head");
		assert.equal(courseTicks(ANA, c), "none");
		assert.deepEqual(chosenCourses(ENTRIES, c), []);
	});

	it("a subdeck ticked on a course that is not held brings the course with just that subdeck", () => {
		const c = toggleTopic(choiceOfHeld([]), ANA, "W10 Leg");
		assert.equal(courseTicks(ANA, c), "some");
		assert.deepEqual(chosenCourses(ENTRIES, c), ["ana"]);
		assert.deepEqual(chosenTopics(ENTRIES, c), { ana: ["W10 Leg"] });
	});

	it("a subdeck the course does not have, or a course without subdecks to tell apart, changes nothing", () => {
		const c = choiceOfHeld(["ana", "bio"]);
		assert.equal(toggleTopic(c, ANA, "W7 nowhere"), c);
		assert.equal(toggleTopic(c, BIO, "W1 Cell"), c);
		assert.equal(toggleTopic(c, CHEM, ""), c);
	});

	it("never changes the choice it was given", () => {
		const c = choiceOfHeld(["ana"]);
		toggleTopic(c, ANA, "W1 Head");
		toggleCourse(c, ANA);
		assert.equal(courseTicks(ANA, c), "all");
	});
});

describe("the totals and the lines", () => {
	it("count a whole course by the course's own figures", () => {
		const c = choiceOfAll(ENTRIES);
		assert.deepEqual(choiceCounts(ENTRIES, c), { courses: 3, cards: 1020, mediaBytes: 20_000_000, approximate: false });
		assert.equal(choiceTotal(ENTRIES, c), "3 courses · 1020 cards · 20 MB of pictures and sounds");
	});

	it("count a course in part by the subdecks ticked, and say the size is an upper bound", () => {
		const c = choiceOfHeld(["ana", "chem"], { ana: ["W1 Head", "W2 Arm"] });
		assert.deepEqual(choiceCounts(ENTRIES, c), { courses: 2, cards: 420, mediaBytes: 15_000_000, approximate: true });
		assert.equal(choiceTotal(ENTRIES, c), "2 courses · 420 cards · up to 15 MB of pictures and sounds");
	});

	it("say one course and one card in the singular, and leave out a size of nothing", () => {
		const one: PhoneCatalogEntry = { id: "x", name: "X", cards: 1, mediaBytes: 0 };
		assert.equal(choiceTotal([one], choiceOfAll([one])), "1 course · 1 card");
	});

	it("tell under a course its cards, its size and its subdecks", () => {
		const all = choiceOfAll(ENTRIES);
		assert.equal(courseLine(ANA, all), "600 cards · 20 MB · 4 subdecks");
		assert.equal(courseLine(BIO, all), "300 cards");
		assert.equal(courseLine(CHEM, all), "120 cards");
		assert.equal(courseLine(ANA, choiceOfHeld(["ana"], { ana: ["W2 Arm", "W10 Leg"] })), "2 of 4 subdecks · 450 cards · up to 17 MB");
		assert.equal(courseLine(ANA, choiceOfHeld(["ana"], { ana: ["", "W1 Head"] })), "2 of 4 subdecks · 150 cards · up to 6 MB");
		assert.equal(courseLine(ANA, choiceOfHeld(["bio"])), "600 cards · 20 MB · 4 subdecks", "a course not held shows what it would bring");
	});
});

describe("what leaves and what comes of the courses that stay", () => {
	it("lists the subdecks that go and the ones that come, per course, with 'no subdeck' for the nameless one", () => {
		const before = choiceOfHeld(["ana", "bio"], { ana: ["W1 Head", "W2 Arm"] });
		const after = choiceOfHeld(["ana", "bio"], { ana: ["W2 Arm", "", "W10 Leg"] });
		assert.deepEqual(subdeckChanges(ENTRIES, before, after), {
			leaving: [{ course: "Anatomy", topics: ["W1 Head"] }],
			arriving: [{ course: "Anatomy", topics: ["W10 Leg", "no subdeck"] }],
		});
	});

	it("counts a whole course as all its subdecks", () => {
		const whole = choiceOfHeld(["ana"]);
		const part = choiceOfHeld(["ana"], { ana: ["W1 Head"] });
		assert.deepEqual(subdeckChanges(ENTRIES, whole, part).leaving, [{ course: "Anatomy", topics: ["W2 Arm", "W10 Leg", "no subdeck"] }]);
		assert.deepEqual(subdeckChanges(ENTRIES, part, whole).arriving, [{ course: "Anatomy", topics: ["W2 Arm", "W10 Leg", "no subdeck"] }]);
	});

	it("says nothing for a course that comes or goes whole, or for no change", () => {
		const held = choiceOfHeld(["ana"], { ana: ["W1 Head"] });
		assert.deepEqual(subdeckChanges(ENTRIES, held, choiceOfHeld([])), { leaving: [], arriving: [] });
		assert.deepEqual(subdeckChanges(ENTRIES, choiceOfHeld([]), held), { leaving: [], arriving: [] });
		assert.deepEqual(subdeckChanges(ENTRIES, held, held), { leaving: [], arriving: [] });
	});
});
