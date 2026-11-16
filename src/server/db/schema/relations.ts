import { relations } from 'drizzle-orm';
import {
  aiConversations,
  aiMessages,
  aiPermissions,
  aiPromptVersions,
  aiRunContextLinks,
  aiRuns,
  aiUsageRecords,
} from './ai';
import {
  applicationChecklists,
  applicationDocuments,
  applicationNotes,
  applicationStatusHistory,
  savedOpportunities,
  scholarshipApplications,
  universityApplications,
} from './applications';
import { documents, documentVersions, storedFiles } from './documents';
import { accountSettings, authIdentities, userConsents, users } from './identity';
import { institutionAliases, institutions } from './institutions';
import { externalIdentityPurgeOutbox } from './outbox';
import {
  notificationDeliveries,
  notificationPreferences,
  plannerEvents,
  plannerTasks,
} from './planner';
import {
  studentExperiences,
  studentProfiles,
  studentPublicationsAndProjects,
  studentQualifications,
  studentTestScores,
} from './profiles';
import {
  programmeFees,
  programmeIntakes,
  programmeRequirements,
  programmes,
} from './programmes';
import { gradingScales, testCatalog } from './reference';
import {
  scholarshipEligibilityRules,
  scholarshipFundingComponents,
  scholarshipIntakes,
  scholarshipProgrammes,
  scholarships,
} from './scholarships';
import { sources, verificationClaims, verificationEvidence } from './verification';

export const usersRelations = relations(users, ({ one, many }) => ({
  authIdentities: many(authIdentities),
  accountSettings: one(accountSettings),
  consents: many(userConsents),
  studentProfile: one(studentProfiles),
  qualifications: many(studentQualifications, { relationName: 'qualificationOwner' }),
  verifiedQualifications: many(studentQualifications, { relationName: 'qualificationVerifier' }),
  testScores: many(studentTestScores, { relationName: 'testScoreOwner' }),
  verifiedTestScores: many(studentTestScores, { relationName: 'testScoreVerifier' }),
  experiences: many(studentExperiences, { relationName: 'experienceOwner' }),
  verifiedExperiences: many(studentExperiences, { relationName: 'experienceVerifier' }),
  publicationsAndProjects: many(studentPublicationsAndProjects, { relationName: 'pubProjOwner' }),
  verifiedPublicationsAndProjects: many(studentPublicationsAndProjects, {
    relationName: 'pubProjVerifier',
  }),
  ownedStoredFiles: many(storedFiles, { relationName: 'storedFileOwner' }),
  deletedStoredFiles: many(storedFiles, { relationName: 'storedFileDeleter' }),
  documents: many(documents, { relationName: 'documentOwner' }),
  archivedDocuments: many(documents, { relationName: 'documentArchiver' }),
  documentVersions: many(documentVersions, { relationName: 'docVersionOwner' }),
  uploadedDocumentVersions: many(documentVersions, { relationName: 'docVersionUploader' }),
  savedOpportunities: many(savedOpportunities),
  universityApplications: many(universityApplications),
  scholarshipApplications: many(scholarshipApplications),
  applicationDocuments: many(applicationDocuments),
  applicationChecklists: many(applicationChecklists),
  applicationNotes: many(applicationNotes, { relationName: 'noteOwner' }),
  authoredApplicationNotes: many(applicationNotes, { relationName: 'noteAuthor' }),
  applicationStatusHistories: many(applicationStatusHistory, { relationName: 'statusHistoryOwner' }),
  changedApplicationStatuses: many(applicationStatusHistory, {
    relationName: 'statusHistoryChanger',
  }),
  plannerTasks: many(plannerTasks),
  plannerEvents: many(plannerEvents),
  notificationPreferences: one(notificationPreferences),
  notificationDeliveries: many(notificationDeliveries),
  aiPermissions: many(aiPermissions, { relationName: 'permissionUser' }),
  grantedAiPermissions: many(aiPermissions, { relationName: 'permissionGrantor' }),
  aiConversations: many(aiConversations),
  aiMessages: many(aiMessages),
  aiRuns: many(aiRuns),
  aiUsageRecords: many(aiUsageRecords),
  aiRunContextLinks: many(aiRunContextLinks),
  verifiedClaims: many(verificationClaims),
}));

export const authIdentitiesRelations = relations(authIdentities, ({ one }) => ({
  user: one(users, {
    fields: [authIdentities.userId],
    references: [users.id],
  }),
}));

export const accountSettingsRelations = relations(accountSettings, ({ one }) => ({
  user: one(users, {
    fields: [accountSettings.userId],
    references: [users.id],
  }),
}));

export const userConsentsRelations = relations(userConsents, ({ one }) => ({
  user: one(users, {
    fields: [userConsents.userId],
    references: [users.id],
  }),
}));

export const gradingScalesRelations = relations(gradingScales, ({ many }) => ({
  studentQualifications: many(studentQualifications),
  programmeRequirements: many(programmeRequirements),
  scholarshipEligibilityRules: many(scholarshipEligibilityRules),
}));

export const testCatalogRelations = relations(testCatalog, ({ many }) => ({
  studentTestScores: many(studentTestScores),
  programmeRequirements: many(programmeRequirements),
  scholarshipEligibilityRules: many(scholarshipEligibilityRules),
}));

export const studentProfilesRelations = relations(studentProfiles, ({ one }) => ({
  user: one(users, {
    fields: [studentProfiles.userId],
    references: [users.id],
  }),
}));

export const studentQualificationsRelations = relations(
  studentQualifications,
  ({ one, many }) => ({
    user: one(users, {
      fields: [studentQualifications.userId],
      references: [users.id],
      relationName: 'qualificationOwner',
    }),
    verifiedByUser: one(users, {
      fields: [studentQualifications.verifiedByUserId],
      references: [users.id],
      relationName: 'qualificationVerifier',
    }),
    gradingScale: one(gradingScales, {
      fields: [studentQualifications.gradingScaleCode],
      references: [gradingScales.code],
    }),
    evidenceDocumentVersion: one(documentVersions, {
      fields: [studentQualifications.evidenceDocumentVersionId],
      references: [documentVersions.id],
    }),
    aiRunContextLinks: many(aiRunContextLinks),
  }),
);

export const studentTestScoresRelations = relations(studentTestScores, ({ one, many }) => ({
  user: one(users, {
    fields: [studentTestScores.userId],
    references: [users.id],
    relationName: 'testScoreOwner',
  }),
  verifiedByUser: one(users, {
    fields: [studentTestScores.verifiedByUserId],
    references: [users.id],
    relationName: 'testScoreVerifier',
  }),
  testDefinition: one(testCatalog, {
    fields: [studentTestScores.testCode],
    references: [testCatalog.code],
  }),
  evidenceDocumentVersion: one(documentVersions, {
    fields: [studentTestScores.evidenceDocumentVersionId],
    references: [documentVersions.id],
  }),
  aiRunContextLinks: many(aiRunContextLinks),
}));

export const studentExperiencesRelations = relations(studentExperiences, ({ one }) => ({
  user: one(users, {
    fields: [studentExperiences.userId],
    references: [users.id],
    relationName: 'experienceOwner',
  }),
  verifiedByUser: one(users, {
    fields: [studentExperiences.verifiedByUserId],
    references: [users.id],
    relationName: 'experienceVerifier',
  }),
  evidenceDocumentVersion: one(documentVersions, {
    fields: [studentExperiences.evidenceDocumentVersionId],
    references: [documentVersions.id],
  }),
}));

export const studentPublicationsAndProjectsRelations = relations(
  studentPublicationsAndProjects,
  ({ one }) => ({
    user: one(users, {
      fields: [studentPublicationsAndProjects.userId],
      references: [users.id],
      relationName: 'pubProjOwner',
    }),
    verifiedByUser: one(users, {
      fields: [studentPublicationsAndProjects.verifiedByUserId],
      references: [users.id],
      relationName: 'pubProjVerifier',
    }),
    evidenceDocumentVersion: one(documentVersions, {
      fields: [studentPublicationsAndProjects.evidenceDocumentVersionId],
      references: [documentVersions.id],
    }),
  }),
);

export const institutionsRelations = relations(institutions, ({ many }) => ({
  aliases: many(institutionAliases),
  programmes: many(programmes),
  scholarships: many(scholarships),
  universityApplications: many(universityApplications),
  verificationClaims: many(verificationClaims),
  aiRunContextLinks: many(aiRunContextLinks),
}));

export const institutionAliasesRelations = relations(institutionAliases, ({ one }) => ({
  institution: one(institutions, {
    fields: [institutionAliases.institutionId],
    references: [institutions.id],
  }),
}));

export const programmesRelations = relations(programmes, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [programmes.institutionId],
    references: [institutions.id],
  }),
  intakes: many(programmeIntakes),
  fees: many(programmeFees),
  requirements: many(programmeRequirements),
  scholarshipLinks: many(scholarshipProgrammes),
  savedByUsers: many(savedOpportunities),
  universityApplications: many(universityApplications),
  verificationClaims: many(verificationClaims),
  aiRunContextLinks: many(aiRunContextLinks),
}));

export const programmeIntakesRelations = relations(programmeIntakes, ({ one, many }) => ({
  programme: one(programmes, {
    fields: [programmeIntakes.programmeId],
    references: [programmes.id],
  }),
  universityApplications: many(universityApplications),
}));

export const programmeFeesRelations = relations(programmeFees, ({ one }) => ({
  programme: one(programmes, {
    fields: [programmeFees.programmeId],
    references: [programmes.id],
  }),
}));

export const programmeRequirementsRelations = relations(programmeRequirements, ({ one }) => ({
  programme: one(programmes, {
    fields: [programmeRequirements.programmeId],
    references: [programmes.id],
  }),
  gradingScale: one(gradingScales, {
    fields: [programmeRequirements.gradingScaleCode],
    references: [gradingScales.code],
  }),
  testDefinition: one(testCatalog, {
    fields: [programmeRequirements.testCode],
    references: [testCatalog.code],
  }),
}));

export const scholarshipsRelations = relations(scholarships, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [scholarships.institutionId],
    references: [institutions.id],
  }),
  intakes: many(scholarshipIntakes),
  programmeLinks: many(scholarshipProgrammes),
  eligibilityRules: many(scholarshipEligibilityRules),
  fundingComponents: many(scholarshipFundingComponents),
  savedByUsers: many(savedOpportunities),
  scholarshipApplications: many(scholarshipApplications),
  verificationClaims: many(verificationClaims),
  aiRunContextLinks: many(aiRunContextLinks),
}));

export const scholarshipIntakesRelations = relations(scholarshipIntakes, ({ one, many }) => ({
  scholarship: one(scholarships, {
    fields: [scholarshipIntakes.scholarshipId],
    references: [scholarships.id],
  }),
  scholarshipApplications: many(scholarshipApplications),
}));

export const scholarshipProgrammesRelations = relations(scholarshipProgrammes, ({ one }) => ({
  scholarship: one(scholarships, {
    fields: [scholarshipProgrammes.scholarshipId],
    references: [scholarships.id],
  }),
  programme: one(programmes, {
    fields: [scholarshipProgrammes.programmeId],
    references: [programmes.id],
  }),
}));

export const scholarshipEligibilityRulesRelations = relations(
  scholarshipEligibilityRules,
  ({ one }) => ({
    scholarship: one(scholarships, {
      fields: [scholarshipEligibilityRules.scholarshipId],
      references: [scholarships.id],
    }),
    gradingScale: one(gradingScales, {
      fields: [scholarshipEligibilityRules.gradingScaleCode],
      references: [gradingScales.code],
    }),
    testDefinition: one(testCatalog, {
      fields: [scholarshipEligibilityRules.testCode],
      references: [testCatalog.code],
    }),
  }),
);

export const scholarshipFundingComponentsRelations = relations(
  scholarshipFundingComponents,
  ({ one }) => ({
    scholarship: one(scholarships, {
      fields: [scholarshipFundingComponents.scholarshipId],
      references: [scholarships.id],
    }),
  }),
);

export const sourcesRelations = relations(sources, ({ many }) => ({
  evidence: many(verificationEvidence),
}));

export const verificationClaimsRelations = relations(verificationClaims, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [verificationClaims.institutionId],
    references: [institutions.id],
  }),
  programme: one(programmes, {
    fields: [verificationClaims.programmeId],
    references: [programmes.id],
  }),
  scholarship: one(scholarships, {
    fields: [verificationClaims.scholarshipId],
    references: [scholarships.id],
  }),
  verifiedByUser: one(users, {
    fields: [verificationClaims.verifiedByUserId],
    references: [users.id],
  }),
  supersededByClaim: one(verificationClaims, {
    fields: [verificationClaims.supersededByClaimId],
    references: [verificationClaims.id],
    relationName: 'claimSupersession',
  }),
  supersedingClaims: many(verificationClaims, {
    relationName: 'claimSupersession',
  }),
  evidence: many(verificationEvidence),
}));

export const verificationEvidenceRelations = relations(verificationEvidence, ({ one }) => ({
  claim: one(verificationClaims, {
    fields: [verificationEvidence.claimId],
    references: [verificationClaims.id],
  }),
  source: one(sources, {
    fields: [verificationEvidence.sourceId],
    references: [sources.id],
  }),
}));

export const storedFilesRelations = relations(storedFiles, ({ one, many }) => ({
  owner: one(users, {
    fields: [storedFiles.ownerUserId],
    references: [users.id],
    relationName: 'storedFileOwner',
  }),
  deletedByUser: one(users, {
    fields: [storedFiles.deletedByUserId],
    references: [users.id],
    relationName: 'storedFileDeleter',
  }),
  documentVersions: many(documentVersions),
}));

export const documentsRelations = relations(documents, ({ one, many }) => ({
  user: one(users, {
    fields: [documents.userId],
    references: [users.id],
    relationName: 'documentOwner',
  }),
  archivedByUser: one(users, {
    fields: [documents.archivedByUserId],
    references: [users.id],
    relationName: 'documentArchiver',
  }),
  versions: many(documentVersions),
  applicationDocuments: many(applicationDocuments),
  linkedChecklists: many(applicationChecklists),
  aiRunContextLinks: many(aiRunContextLinks),
}));

export const documentVersionsRelations = relations(documentVersions, ({ one, many }) => ({
  document: one(documents, {
    fields: [documentVersions.documentId],
    references: [documents.id],
  }),
  user: one(users, {
    fields: [documentVersions.userId],
    references: [users.id],
    relationName: 'docVersionOwner',
  }),
  storedFile: one(storedFiles, {
    fields: [documentVersions.storedFileId],
    references: [storedFiles.id],
  }),
  uploadedByUser: one(users, {
    fields: [documentVersions.uploadedByUserId],
    references: [users.id],
    relationName: 'docVersionUploader',
  }),
  applicationDocuments: many(applicationDocuments),
  qualificationEvidence: many(studentQualifications),
  testScoreEvidence: many(studentTestScores),
  experienceEvidence: many(studentExperiences),
  publicationAndProjectEvidence: many(studentPublicationsAndProjects),
  aiRunContextLinks: many(aiRunContextLinks),
}));

export const savedOpportunitiesRelations = relations(savedOpportunities, ({ one }) => ({
  user: one(users, {
    fields: [savedOpportunities.userId],
    references: [users.id],
  }),
  programme: one(programmes, {
    fields: [savedOpportunities.programmeId],
    references: [programmes.id],
  }),
  scholarship: one(scholarships, {
    fields: [savedOpportunities.scholarshipId],
    references: [scholarships.id],
  }),
}));

export const universityApplicationsRelations = relations(
  universityApplications,
  ({ one, many }) => ({
    user: one(users, {
      fields: [universityApplications.userId],
      references: [users.id],
    }),
    institution: one(institutions, {
      fields: [universityApplications.institutionId],
      references: [institutions.id],
    }),
    programme: one(programmes, {
      fields: [universityApplications.programmeId],
      references: [programmes.id],
    }),
    programmeIntake: one(programmeIntakes, {
      fields: [universityApplications.programmeIntakeId],
      references: [programmeIntakes.id],
    }),
    linkedScholarshipApplications: many(scholarshipApplications),
    applicationDocuments: many(applicationDocuments),
    checklists: many(applicationChecklists),
    notes: many(applicationNotes),
    statusHistory: many(applicationStatusHistory),
    plannerTasks: many(plannerTasks),
    plannerEvents: many(plannerEvents),
    notificationDeliveries: many(notificationDeliveries),
    aiConversations: many(aiConversations),
    aiRunContextLinks: many(aiRunContextLinks),
  }),
);

export const scholarshipApplicationsRelations = relations(
  scholarshipApplications,
  ({ one, many }) => ({
    user: one(users, {
      fields: [scholarshipApplications.userId],
      references: [users.id],
    }),
    scholarship: one(scholarships, {
      fields: [scholarshipApplications.scholarshipId],
      references: [scholarships.id],
    }),
    scholarshipIntake: one(scholarshipIntakes, {
      fields: [scholarshipApplications.scholarshipIntakeId],
      references: [scholarshipIntakes.id],
    }),
    universityApplication: one(universityApplications, {
      fields: [scholarshipApplications.universityApplicationId],
      references: [universityApplications.id],
    }),
    applicationDocuments: many(applicationDocuments),
    checklists: many(applicationChecklists),
    notes: many(applicationNotes),
    statusHistory: many(applicationStatusHistory),
    plannerTasks: many(plannerTasks),
    plannerEvents: many(plannerEvents),
    notificationDeliveries: many(notificationDeliveries),
    aiConversations: many(aiConversations),
    aiRunContextLinks: many(aiRunContextLinks),
  }),
);

export const applicationDocumentsRelations = relations(applicationDocuments, ({ one }) => ({
  user: one(users, {
    fields: [applicationDocuments.userId],
    references: [users.id],
  }),
  universityApplication: one(universityApplications, {
    fields: [applicationDocuments.universityApplicationId],
    references: [universityApplications.id],
  }),
  scholarshipApplication: one(scholarshipApplications, {
    fields: [applicationDocuments.scholarshipApplicationId],
    references: [scholarshipApplications.id],
  }),
  document: one(documents, {
    fields: [applicationDocuments.documentId],
    references: [documents.id],
  }),
  documentVersion: one(documentVersions, {
    fields: [applicationDocuments.documentVersionId],
    references: [documentVersions.id],
  }),
  replacedBy: one(applicationDocuments, {
    fields: [applicationDocuments.replacedById],
    references: [applicationDocuments.id],
    relationName: 'appDocReplacement',
  }),
}));

export const applicationChecklistsRelations = relations(applicationChecklists, ({ one }) => ({
  user: one(users, {
    fields: [applicationChecklists.userId],
    references: [users.id],
  }),
  universityApplication: one(universityApplications, {
    fields: [applicationChecklists.universityApplicationId],
    references: [universityApplications.id],
  }),
  scholarshipApplication: one(scholarshipApplications, {
    fields: [applicationChecklists.scholarshipApplicationId],
    references: [scholarshipApplications.id],
  }),
  linkedDocument: one(documents, {
    fields: [applicationChecklists.linkedDocumentId],
    references: [documents.id],
  }),
}));

export const applicationNotesRelations = relations(applicationNotes, ({ one }) => ({
  user: one(users, {
    fields: [applicationNotes.userId],
    references: [users.id],
    relationName: 'noteOwner',
  }),
  authorUser: one(users, {
    fields: [applicationNotes.authorUserId],
    references: [users.id],
    relationName: 'noteAuthor',
  }),
  universityApplication: one(universityApplications, {
    fields: [applicationNotes.universityApplicationId],
    references: [universityApplications.id],
  }),
  scholarshipApplication: one(scholarshipApplications, {
    fields: [applicationNotes.scholarshipApplicationId],
    references: [scholarshipApplications.id],
  }),
}));

export const applicationStatusHistoryRelations = relations(
  applicationStatusHistory,
  ({ one }) => ({
    user: one(users, {
      fields: [applicationStatusHistory.userId],
      references: [users.id],
      relationName: 'statusHistoryOwner',
    }),
    universityApplication: one(universityApplications, {
      fields: [applicationStatusHistory.universityApplicationId],
      references: [universityApplications.id],
    }),
    scholarshipApplication: one(scholarshipApplications, {
      fields: [applicationStatusHistory.scholarshipApplicationId],
      references: [scholarshipApplications.id],
    }),
    changedByUser: one(users, {
      fields: [applicationStatusHistory.changedByUserId],
      references: [users.id],
      relationName: 'statusHistoryChanger',
    }),
  }),
);

export const plannerTasksRelations = relations(plannerTasks, ({ one, many }) => ({
  user: one(users, {
    fields: [plannerTasks.userId],
    references: [users.id],
  }),
  universityApplication: one(universityApplications, {
    fields: [plannerTasks.universityApplicationId],
    references: [universityApplications.id],
  }),
  scholarshipApplication: one(scholarshipApplications, {
    fields: [plannerTasks.scholarshipApplicationId],
    references: [scholarshipApplications.id],
  }),
  notificationDeliveries: many(notificationDeliveries),
}));

export const plannerEventsRelations = relations(plannerEvents, ({ one, many }) => ({
  user: one(users, {
    fields: [plannerEvents.userId],
    references: [users.id],
  }),
  universityApplication: one(universityApplications, {
    fields: [plannerEvents.universityApplicationId],
    references: [universityApplications.id],
  }),
  scholarshipApplication: one(scholarshipApplications, {
    fields: [plannerEvents.scholarshipApplicationId],
    references: [scholarshipApplications.id],
  }),
  notificationDeliveries: many(notificationDeliveries),
}));

export const notificationPreferencesRelations = relations(
  notificationPreferences,
  ({ one }) => ({
    user: one(users, {
      fields: [notificationPreferences.userId],
      references: [users.id],
    }),
  }),
);

export const notificationDeliveriesRelations = relations(notificationDeliveries, ({ one }) => ({
  user: one(users, {
    fields: [notificationDeliveries.userId],
    references: [users.id],
  }),
  universityApplication: one(universityApplications, {
    fields: [notificationDeliveries.universityApplicationId],
    references: [universityApplications.id],
  }),
  scholarshipApplication: one(scholarshipApplications, {
    fields: [notificationDeliveries.scholarshipApplicationId],
    references: [scholarshipApplications.id],
  }),
  plannerTask: one(plannerTasks, {
    fields: [notificationDeliveries.plannerTaskId],
    references: [plannerTasks.id],
  }),
  plannerEvent: one(plannerEvents, {
    fields: [notificationDeliveries.plannerEventId],
    references: [plannerEvents.id],
  }),
}));

export const aiPromptVersionsRelations = relations(aiPromptVersions, ({ many }) => ({
  runs: many(aiRuns),
}));

export const aiPermissionsRelations = relations(aiPermissions, ({ one }) => ({
  user: one(users, {
    fields: [aiPermissions.userId],
    references: [users.id],
    relationName: 'permissionUser',
  }),
  grantedByUser: one(users, {
    fields: [aiPermissions.grantedByUserId],
    references: [users.id],
    relationName: 'permissionGrantor',
  }),
}));

export const aiConversationsRelations = relations(aiConversations, ({ one, many }) => ({
  user: one(users, {
    fields: [aiConversations.userId],
    references: [users.id],
  }),
  universityApplication: one(universityApplications, {
    fields: [aiConversations.universityApplicationId],
    references: [universityApplications.id],
  }),
  scholarshipApplication: one(scholarshipApplications, {
    fields: [aiConversations.scholarshipApplicationId],
    references: [scholarshipApplications.id],
  }),
  messages: many(aiMessages),
  runs: many(aiRuns),
}));

export const aiMessagesRelations = relations(aiMessages, ({ one }) => ({
  conversation: one(aiConversations, {
    fields: [aiMessages.conversationId],
    references: [aiConversations.id],
  }),
  user: one(users, {
    fields: [aiMessages.userId],
    references: [users.id],
  }),
}));

export const aiRunsRelations = relations(aiRuns, ({ one, many }) => ({
  user: one(users, {
    fields: [aiRuns.userId],
    references: [users.id],
  }),
  conversation: one(aiConversations, {
    fields: [aiRuns.conversationId],
    references: [aiConversations.id],
  }),
  promptVersion: one(aiPromptVersions, {
    fields: [aiRuns.promptVersionId],
    references: [aiPromptVersions.id],
  }),
  usageRecord: one(aiUsageRecords),
  contextLinks: many(aiRunContextLinks),
}));

export const aiUsageRecordsRelations = relations(aiUsageRecords, ({ one }) => ({
  aiRun: one(aiRuns, {
    fields: [aiUsageRecords.aiRunId],
    references: [aiRuns.id],
  }),
  user: one(users, {
    fields: [aiUsageRecords.userId],
    references: [users.id],
  }),
}));

export const aiRunContextLinksRelations = relations(aiRunContextLinks, ({ one }) => ({
  user: one(users, {
    fields: [aiRunContextLinks.userId],
    references: [users.id],
  }),
  aiRun: one(aiRuns, {
    fields: [aiRunContextLinks.aiRunId],
    references: [aiRuns.id],
  }),
  document: one(documents, {
    fields: [aiRunContextLinks.documentId],
    references: [documents.id],
  }),
  documentVersion: one(documentVersions, {
    fields: [aiRunContextLinks.documentVersionId],
    references: [documentVersions.id],
  }),
  universityApplication: one(universityApplications, {
    fields: [aiRunContextLinks.universityApplicationId],
    references: [universityApplications.id],
  }),
  scholarshipApplication: one(scholarshipApplications, {
    fields: [aiRunContextLinks.scholarshipApplicationId],
    references: [scholarshipApplications.id],
  }),
  studentQualification: one(studentQualifications, {
    fields: [aiRunContextLinks.studentQualificationId],
    references: [studentQualifications.id],
  }),
  studentTestScore: one(studentTestScores, {
    fields: [aiRunContextLinks.studentTestScoreId],
    references: [studentTestScores.id],
  }),
  institution: one(institutions, {
    fields: [aiRunContextLinks.institutionId],
    references: [institutions.id],
  }),
  programme: one(programmes, {
    fields: [aiRunContextLinks.programmeId],
    references: [programmes.id],
  }),
  scholarship: one(scholarships, {
    fields: [aiRunContextLinks.scholarshipId],
    references: [scholarships.id],
  }),
}));

// Keep externalIdentityPurgeOutbox referenced in schema relations barrel (no FKs by design).
export const externalIdentityPurgeOutboxRelations = relations(
  externalIdentityPurgeOutbox,
  () => ({}),
);
